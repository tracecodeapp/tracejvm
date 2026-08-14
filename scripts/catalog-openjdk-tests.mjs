import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(root, "compatibility/openjdk/manifest.json"), "utf8"),
);
const checkout = join(root, ".cache/openjdk-jdk23u");
const checkoutCommit = execFileSync(
  "git",
  ["-C", checkout, "rev-parse", "HEAD"],
  { encoding: "utf8" },
).trim();
if (checkoutCommit !== manifest.upstream.commit) {
  throw new Error(
    `OpenJDK checkout is ${checkoutCommit}; expected ${manifest.upstream.commit}`,
  );
}
const scopes = (process.env.OPENJDK_SCOPES ?? "java/lang,java/util,java/io")
  .split(",")
  .map((scope) => scope.trim())
  .filter(Boolean);

function walk(directory) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...walk(path));
    else if (entry.isFile() && entry.name.endsWith(".java")) paths.push(path);
  }
  return paths;
}

function directives(source, name) {
  const matcher = new RegExp(`^[ \\t/*]*@${name}(?:[ \\t]+(.*))?$`, "gmu");
  return Array.from(source.matchAll(matcher), (match) => (match[1] ?? "").trim());
}

function classify(source) {
  const tests = directives(source, "test");
  const runs = directives(source, "run");
  const libraries = directives(source, "library");
  const builds = directives(source, "build");
  const modules = directives(source, "modules");
  const requires = directives(source, "requires");
  const compile = directives(source, "compile");
  const reasons = [];

  if (runs.some((run) => /(?:^|[/ ])manual(?:[/ ]|$)/u.test(run))) {
    return { classification: "manual", reasons: ["manual jtreg mode"], runs };
  }
  if (runs.some((run) => /(?:^|[/ ])native(?:[/ ]|$)/u.test(run))) {
    return { classification: "native-helper", reasons: ["native jtreg mode"], runs };
  }
  if (
    runs.some((run) => /\btestng\b|\bjunit\b/iu.test(run)) ||
    /(?:org\.(?:testng|junit)|junit\.framework)/u.test(source)
  ) {
    return { classification: "framework", reasons: ["TestNG or JUnit"], runs };
  }
  if (tests.length === 0) {
    return {
      classification: "support-source",
      reasons: ["no @test declaration"],
      runs,
    };
  }
  if (runs.some((run) => /\/othervm\b/u.test(run))) reasons.push("requires a fresh VM");
  if (libraries.length > 0) reasons.push("@library dependencies");
  if (builds.length > 0) reasons.push("@build dependencies");
  if (modules.length > 0) reasons.push("@modules access");
  if (requires.length > 0) reasons.push("@requires predicate");
  if (runs.some((run) => /\bdriver\b/u.test(run))) reasons.push("jtreg driver");
  if (compile.length > 0) reasons.push("@compile phase");
  if (
    runs.some((run) => /\bmain\/(?!timeout=)[^ ]+/u.test(run))
  ) {
    reasons.push("special main mode");
  }

  const mainRuns = runs.filter((run) => /(?:^| )main(?:\/[^ ]+)?[ \t]+/u.test(run));
  const hasMain = /\bstatic\s+void\s+main\s*\(\s*(?:java\.lang\.)?String(?:\[\]|\s*\.\.\.)/u
    .test(source);
  if (reasons.length === 0 && mainRuns.length > 0) {
    return {
      classification: "direct-main-candidate",
      reasons: [],
      runs,
    };
  }
  if (reasons.length === 0 && runs.length === 0 && hasMain) {
    return {
      classification: "implicit-main-candidate",
      reasons: ["jtreg default main; sibling dependencies require discovery"],
      runs,
    };
  }
  if (reasons.length > 0) {
    return { classification: "requires-jtreg-support", reasons, runs };
  }
  return {
    classification: "needs-triage",
    reasons: hasMain ? ["unclassified main program"] : ["no directly runnable main"],
    runs,
  };
}

const entries = [];
for (const scope of scopes) {
  const directory = join(checkout, "test", manifest.suite, scope);
  for (const path of walk(directory)) {
    const source = readFileSync(path, "utf8");
    entries.push({
      path: relative(join(checkout, "test", manifest.suite), path),
      ...classify(source),
    });
  }
}
entries.sort((left, right) => left.path.localeCompare(right.path));

const counts = Object.fromEntries(
  Array.from(
    entries.reduce((map, entry) => {
      map.set(entry.classification, (map.get(entry.classification) ?? 0) + 1);
      return map;
    }, new Map()),
  ).sort(([left], [right]) => left.localeCompare(right)),
);
const output = {
  generatedFrom: manifest.upstream,
  scopes,
  total: entries.length,
  counts,
  entries,
};
writeFileSync(
  join(root, "compatibility/openjdk/catalog.json"),
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(JSON.stringify({ scopes, total: entries.length, counts }, null, 2));
