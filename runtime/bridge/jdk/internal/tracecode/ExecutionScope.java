package jdk.internal.tracecode;

import java.io.InputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Properties;
import java.util.Set;
import java.util.TimeZone;

/**
 * Restores Java process state around one application entry point.
 *
 * <p>This is a JVM primitive rather than a product adapter. Consumers decide how to handle a
 * tainted scope; TraceJVM only reports whether reuse is safe under the capabilities it can prove.
 */
final class ExecutionScope implements AutoCloseable {
  private final List<String> restored = new ArrayList<>();
  private final List<String> taintReasons = new ArrayList<>();
  private final Properties priorProperties = copyProperties(System.getProperties());
  private final InputStream priorIn = System.in;
  private final PrintStream priorOut = System.out;
  private final PrintStream priorErr = System.err;
  private final Thread currentThread = Thread.currentThread();
  private final String priorThreadName = currentThread.getName();
  private final int priorThreadPriority = currentThread.getPriority();
  private final ClassLoader priorContextClassLoader = currentThread.getContextClassLoader();
  private final Thread.UncaughtExceptionHandler priorUncaughtHandler =
      currentThread.getUncaughtExceptionHandler();
  private final Thread.UncaughtExceptionHandler priorDefaultUncaughtHandler =
      Thread.getDefaultUncaughtExceptionHandler();
  private final boolean priorInterrupted = Thread.interrupted();
  private final Locale priorLocale = Locale.getDefault();
  private final Locale priorDisplayLocale = Locale.getDefault(Locale.Category.DISPLAY);
  private final Locale priorFormatLocale = Locale.getDefault(Locale.Category.FORMAT);
  private final TimeZone priorTimeZone = TimeZone.getDefault();
  private final long priorThreadCreationEpoch = threadCreationEpoch();
  private final Set<Thread> priorThreads = snapshotThreads();
  private final Field threadLocalsField = threadField("threadLocals");
  private final Field inheritableThreadLocalsField = threadField("inheritableThreadLocals");
  private Object priorThreadLocals;
  private Object priorInheritableThreadLocals;
  private boolean closed;

  void enter(String encodedSystemProperties) {
    isolateThreadLocals();
    isolateStandardStreams();
    Thread.setDefaultUncaughtExceptionHandler(null);
    currentThread.setUncaughtExceptionHandler(null);
    applySystemProperties(encodedSystemProperties);
  }

  void setApplicationClassLoader(ClassLoader loader) {
    currentThread.setContextClassLoader(loader);
  }

  @Override
  public void close() {
    if (closed) return;
    closed = true;

    accountForApplicationThreads();
    restore("system-properties", () -> System.setProperties(priorProperties));
    restore("system-streams", () -> {
      System.setIn(priorIn);
      System.setOut(priorOut);
      System.setErr(priorErr);
    });
    restore("default-locale", () -> {
      Locale.setDefault(priorLocale);
      Locale.setDefault(Locale.Category.DISPLAY, priorDisplayLocale);
      Locale.setDefault(Locale.Category.FORMAT, priorFormatLocale);
    });
    restore("default-time-zone", () -> TimeZone.setDefault(priorTimeZone));
    restore(
        "thread-context-class-loader",
        () -> currentThread.setContextClassLoader(priorContextClassLoader));
    restore("thread-uncaught-handlers", () -> {
      currentThread.setUncaughtExceptionHandler(priorUncaughtHandler);
      Thread.setDefaultUncaughtExceptionHandler(priorDefaultUncaughtHandler);
    });
    restore("thread-metadata", () -> {
      currentThread.setName(priorThreadName);
      currentThread.setPriority(priorThreadPriority);
      Thread.interrupted();
      if (priorInterrupted) currentThread.interrupt();
    });
    restore("thread-locals", this::restoreThreadLocals);
  }

  String report() {
    List<String> lines = new ArrayList<>();
    lines.add(taintReasons.isEmpty() ? "clean" : "tainted");
    for (String capability : restored) lines.add("restored:" + capability);
    for (String reason : taintReasons) lines.add("taint:" + reason);
    return String.join("\n", lines);
  }

  private void isolateThreadLocals() {
    if (threadLocalsField == null || inheritableThreadLocalsField == null) {
      taint("thread-local-isolation-unavailable");
      return;
    }
    try {
      priorThreadLocals = threadLocalsField.get(currentThread);
      priorInheritableThreadLocals = inheritableThreadLocalsField.get(currentThread);
      threadLocalsField.set(currentThread, null);
      inheritableThreadLocalsField.set(currentThread, null);
    } catch (Throwable error) {
      taint("thread-local-isolation-failed");
    }
  }

  private void isolateStandardStreams() {
    try {
      System.setIn(new NonClosingInputStream(priorIn));
      System.setOut(new PrintStream(new NonClosingOutputStream(priorOut), true));
      System.setErr(new PrintStream(new NonClosingOutputStream(priorErr), true));
    } catch (Throwable error) {
      taint("standard-stream-isolation-failed");
    }
  }

  private void restoreThreadLocals() {
    if (threadLocalsField == null || inheritableThreadLocalsField == null) {
      throw new IllegalStateException("Thread-local fields are unavailable");
    }
    try {
      threadLocalsField.set(currentThread, priorThreadLocals);
      inheritableThreadLocalsField.set(currentThread, priorInheritableThreadLocals);
    } catch (ReflectiveOperationException error) {
      throw new IllegalStateException(error);
    }
  }

  private void accountForApplicationThreads() {
    if (threadCreationEpoch() == priorThreadCreationEpoch) return;
    // The monotonic epoch observes even a child that started and exited before
    // the application entry point returned.
    taint("application-thread-created");

    Set<Thread> after = snapshotThreads();
    if (after == null || priorThreads == null) {
      taint("thread-enumeration-unavailable");
      return;
    }
    for (Thread thread : after) {
      if (thread == currentThread || priorThreads.contains(thread)) continue;
      // Until b-jvm has a generation-scoped thread registry, creating an
      // application thread conservatively taints a reusable VM.
      try {
        thread.interrupt();
        thread.join(50);
      } catch (Throwable error) {
        taint("application-thread-cleanup-failed");
      }
      if (thread.isAlive()) taint("application-thread-still-running");
    }
  }

  private Set<Thread> snapshotThreads() {
    try {
      ThreadGroup group = currentThread.getThreadGroup();
      while (group.getParent() != null) group = group.getParent();
      int estimate = Math.max(8, group.activeCount() * 2 + 2);
      for (int attempt = 0; attempt < 4; attempt++) {
        Thread[] threads = new Thread[estimate];
        int count = group.enumerate(threads, true);
        if (count < threads.length) {
          Set<Thread> result = Collections.newSetFromMap(new IdentityHashMap<>());
          for (int index = 0; index < count; index++) {
            if (threads[index] != null) result.add(threads[index]);
          }
          return result;
        }
        estimate *= 2;
      }
      return null;
    } catch (Throwable error) {
      return null;
    }
  }

  private void applySystemProperties(String encoded) {
    String[] entries = TraceJVMRunner.decodeArguments(encoded);
    if ((entries.length & 1) != 0) {
      throw new IllegalArgumentException("Malformed TraceJVM system-property payload");
    }
    for (int index = 0; index < entries.length; index += 2) {
      System.setProperty(entries[index], entries[index + 1]);
    }
  }

  private void restore(String capability, ThrowingRunnable operation) {
    try {
      operation.run();
      restored.add(capability);
    } catch (Throwable error) {
      taint(capability + "-restore-failed");
    }
  }

  private void taint(String reason) {
    if (!taintReasons.contains(reason)) taintReasons.add(reason);
  }

  private static Properties copyProperties(Properties source) {
    return (Properties) source.clone();
  }

  private static native long threadCreationEpoch();

  private static Field threadField(String name) {
    try {
      Field field = Thread.class.getDeclaredField(name);
      field.setAccessible(true);
      return field;
    } catch (Throwable error) {
      return null;
    }
  }

  @FunctionalInterface
  private interface ThrowingRunnable {
    void run() throws Throwable;
  }

  private static final class NonClosingInputStream extends InputStream {
    private final InputStream delegate;

    private NonClosingInputStream(InputStream delegate) {
      this.delegate = delegate;
    }

    @Override
    public int read() throws IOException {
      return delegate.read();
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
      return delegate.read(buffer, offset, length);
    }

    @Override
    public long skip(long count) throws IOException {
      return delegate.skip(count);
    }

    @Override
    public int available() throws IOException {
      return delegate.available();
    }

    @Override
    public void close() {
      // The application owns this run-scoped view, not the host stream.
    }
  }

  private static final class NonClosingOutputStream extends OutputStream {
    private final OutputStream delegate;

    private NonClosingOutputStream(OutputStream delegate) {
      this.delegate = delegate;
    }

    @Override
    public void write(int value) throws IOException {
      delegate.write(value);
    }

    @Override
    public void write(byte[] buffer, int offset, int length) throws IOException {
      delegate.write(buffer, offset, length);
    }

    @Override
    public void flush() throws IOException {
      delegate.flush();
    }

    @Override
    public void close() throws IOException {
      delegate.flush();
    }
  }
}
