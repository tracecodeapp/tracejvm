package jdk.internal.tracecode;

import java.io.File;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/** Runs precompiled Java classfiles inside one process-scoped TraceJVM. */
public final class TraceJVMRunner {
  private static String lastIsolationReport = "not-applicable";

  private TraceJVMRunner() {}

  public static String runCompiled(
      String outputDirectory,
      String mainClass,
      String encodedArguments,
      String classpath,
      String encodedSystemProperties) {
    ExecutionScope scope = new ExecutionScope();
    try {
      scope.enter(encodedSystemProperties);
      List<URL> urls = new ArrayList<>();
      urls.add(new File(outputDirectory).toURI().toURL());
      if (!classpath.isEmpty()) {
        for (String entry : classpath.split(File.pathSeparator)) {
          if (!entry.isEmpty()) urls.add(new File(entry).toURI().toURL());
        }
      }
      try (URLClassLoader loader =
          URLClassLoader.newInstance(urls.toArray(URL[]::new))) {
        scope.setApplicationClassLoader(loader);
        Class<?> entry = Class.forName(mainClass, true, loader);
        Method main = entry.getMethod("main", String[].class);
        try {
          main.invoke(null, (Object) decodeArguments(encodedArguments));
          return "";
        } catch (InvocationTargetException invocation) {
          Throwable cause = invocation.getCause();
          if (cause != null) throw cause;
          throw invocation;
        }
      }
    } catch (Throwable error) {
      error.printStackTrace(System.err);
      return "__FAILED__:" + error.getClass().getName() + ":" + error.getMessage();
    } finally {
      scope.close();
      lastIsolationReport = scope.report();
    }
  }

  public static String takeLastIsolationReport() {
    String report = lastIsolationReport;
    lastIsolationReport = "not-applicable";
    return report;
  }

  static String[] decodeArguments(String encoded) {
    String[] lines = encoded.split("\\n", -1);
    int count = Integer.parseInt(lines[0]);
    if (count < 0 || lines.length != count + 1) {
      throw new IllegalArgumentException("Malformed TraceJVM argument payload");
    }
    String[] arguments = new String[count];
    for (int index = 0; index < count; index++) {
      byte[] bytes = Base64.getDecoder().decode(lines[index + 1]);
      arguments[index] =
          new String(bytes, java.nio.charset.StandardCharsets.UTF_8);
    }
    return arguments;
  }
}
