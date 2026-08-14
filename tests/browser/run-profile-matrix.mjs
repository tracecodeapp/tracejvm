import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, devices, firefox, webkit } from "playwright";

const port = Number(process.env.PORT ?? 8765);
const origin = `http://127.0.0.1:${port}`;
const requested = new Set(
  (process.env.BROWSERS ??
    "chromium,firefox,webkit,webkit-ipad-emulation").split(","),
);
const engines = {
  chromium: { engine: chromium },
  firefox: { engine: firefox },
  webkit: { engine: webkit },
  "webkit-ipad-emulation": {
    engine: webkit,
    context: devices["iPad Pro 11"],
  },
};
const server = spawn(process.execPath, ["tests/browser/serve.mjs"], {
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "inherit"],
});

await new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("TraceJVM profile host did not start")),
    10_000,
  );
  server.once("exit", (code) => {
    clearTimeout(timeout);
    reject(new Error(`TraceJVM profile host exited with ${code}`));
  });
  server.stdout.on("data", (chunk) => {
    if (chunk.toString().includes("TraceJVM compatibility host")) {
      clearTimeout(timeout);
      resolve();
    }
  });
});

const cases = [
  {
    profile: "core",
    expectedStatus: "compile-error",
    mainClass: "CoreRejectsServer",
    source: `
      import java.net.http.HttpClient;
      public class CoreRejectsServer {
        public static void main(String[] args) {
          System.out.println(HttpClient.newBuilder());
        }
      }
    `,
  },
  {
    profile: "server",
    expectedStatus: "completed",
    mainClass: "ServerSurface",
    expectedOutput: "server-ok",
    source: `
      import java.net.URI;
      import java.net.http.HttpRequest;
      import java.sql.SQLException;
      import java.util.logging.Logger;
      import javax.xml.parsers.DocumentBuilderFactory;

      public class ServerSurface {
        public static void main(String[] args) throws Exception {
          Logger logger = Logger.getLogger("tracejvm");
          HttpRequest request =
              HttpRequest.newBuilder(URI.create("https://example.test/")).GET().build();
          SQLException sql = new SQLException("expected");
          DocumentBuilderFactory xml = DocumentBuilderFactory.newInstance();
          if (logger == null || request == null || sql == null || xml == null) {
            throw new AssertionError("server API unavailable");
          }
          System.out.println("server-ok");
        }
      }
    `,
  },
  {
    profile: "server",
    expectedStatus: "completed",
    mainClass: "ServerModuleIdentity",
    expectedOutput: [
      "java.net.http",
      "java.logging",
      "java.sql",
      "java.xml",
      "jdk.httpserver",
    ].join("\\n"),
    source: `
      import com.sun.net.httpserver.HttpServer;
      import java.net.http.HttpClient;
      import java.sql.DriverManager;
      import java.util.logging.Logger;
      import javax.xml.parsers.DocumentBuilderFactory;

      public class ServerModuleIdentity {
        public static void main(String[] args) {
          System.out.println(HttpClient.class.getModule().getName());
          System.out.println(Logger.class.getModule().getName());
          System.out.println(DriverManager.class.getModule().getName());
          System.out.println(DocumentBuilderFactory.class.getModule().getName());
          System.out.println(HttpServer.class.getModule().getName());
        }
      }
    `,
  },
  {
    profile: "server",
    expectedStatus: "completed",
    mainClass: "ServerPureBehavior",
    expectedOutput: "server-behavior-ok:tracejvm:expected-state",
    source: `
      import java.io.ByteArrayInputStream;
      import java.net.URI;
      import java.nio.charset.StandardCharsets;
      import java.sql.SQLException;
      import javax.xml.parsers.DocumentBuilderFactory;

      public class ServerPureBehavior {
        public static void main(String[] args) throws Exception {
          URI uri = URI.create("https://example.test/projects?id=tracejvm");
          byte[] xml = "<root><name>tracejvm</name></root>"
              .getBytes(StandardCharsets.UTF_8);
          var document = DocumentBuilderFactory.newInstance()
              .newDocumentBuilder()
              .parse(new ByteArrayInputStream(xml));
          SQLException sql = new SQLException("expected", "expected-state");
          String name = document.getElementsByTagName("name").item(0).getTextContent();
          if (!uri.getHost().equals("example.test")) {
            throw new AssertionError("URI behavior changed");
          }
          System.out.println("server-behavior-ok:" + name + ":" + sql.getSQLState());
        }
      }
    `,
  },
  {
    profile: "spring-server",
    expectedStatus: "completed",
    mainClass: "BeanSurface",
    expectedOutput: "bean-ok:value",
    librarySource: `
      package fixture;
      public final class Support {
        private Support() {}
        public static String suffix() { return "value"; }
      }
    `,
    source: `
      import java.beans.Introspector;
      import java.util.Arrays;
      import fixture.Support;

      public class BeanSurface {
        public static final class SampleBean {
          private String value;
          public String getValue() { return value; }
          public void setValue(String value) { this.value = value; }
        }

        public static void main(String[] args) throws Exception {
          var info = Introspector.getBeanInfo(SampleBean.class);
          var property = Arrays.stream(info.getPropertyDescriptors())
              .filter(candidate -> candidate.getName().equals("value"))
              .findFirst()
              .orElseThrow();
          SampleBean bean = new SampleBean();
          property.getWriteMethod().invoke(bean, Support.suffix());
          System.out.println("bean-ok:" + property.getReadMethod().invoke(bean));
        }
      }
    `,
  },
];

const report = {};
try {
  for (const [engineName, configuration] of Object.entries(engines)) {
    if (!requested.has(engineName)) continue;
    const browser = await configuration.engine.launch({ headless: true });
    const page = await browser.newPage(configuration.context);
    await page.goto(origin);
    const browserReport = [];
    for (const testCase of cases) {
      const result = await page.evaluate(async (entry) => {
        const api = globalThis.traceJVMTest;
        let classpath = [];
        if (entry.librarySource) {
          const library = await api.compile([
            { path: "fixture/Support.java", content: entry.librarySource },
          ]);
          if (library.status !== "completed" || !library.program) {
            throw new Error(`classpath fixture failed: ${library.stderr}`);
          }
          classpath = library.program.files;
        }
        return api.executeWithProfile(
          entry.profile,
          [{ path: `${entry.mainClass}.java`, content: entry.source }],
          entry.mainClass,
          [],
          classpath,
        );
      }, testCase);
      assert.equal(
        result.status,
        testCase.expectedStatus,
        `${engineName} ${testCase.profile}: ${result.stderr}`,
      );
      if (testCase.expectedOutput) {
        assert.match(result.stdout, new RegExp(`${testCase.expectedOutput}\\s*$`));
      }
      browserReport.push({
        profile: testCase.profile,
        status: result.status,
        initializeMs: result.timings.runtimeInitMs,
        executeMs: result.timings.compileAndRunMs,
      });
    }
    report[engineName] = browserReport;
    await browser.close();
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  server.kill("SIGTERM");
}
