const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const staticDir = path.join(__dirname, "../static");
const source = fs.readFileSync(path.join(staticDir, "app.js"), "utf8");

function row(kind, id) {
  const classes = new Set([`${kind}-row`]);
  const attributes = new Map([["aria-expanded", "false"]]);
  return {
    dataset: kind === "artifact" ? { artifactId: id } : { eventId: id },
    classList: {
      contains: (name) => classes.has(name),
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
    },
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
  };
}

function harness() {
  const rows = [row("trigger", "1"), row("trigger", "2"), row("artifact", "repoingest:repo_root")];
  const buttons = {};
  for (const kind of ["trigger", "artifact"]) {
    const attributes = new Map([["aria-expanded", "false"]]);
    buttons[`expand-${kind}`] = {
      attributes, textContent: "", disabled: true,
      setAttribute: (key, value) => attributes.set(key, value),
      getAttribute: (key) => attributes.get(key),
      addEventListener(name, handler) { this[name] = handler; },
    };
  }
  const context = vm.createContext({
    URLSearchParams, window: { location: { search: "" } },
    document: { getElementById: (id) => buttons[id] },
    monitor: { querySelectorAll: (selector) => rows.filter((r) => r.classList.contains(selector.slice(1))) },
  });
  const definitions = source.slice(0, source.indexOf('const monitor ='));
  const interactions = source.slice(source.indexOf('function rowKind'), source.indexOf('monitor.addEventListener("click"'));
  vm.runInContext(definitions + interactions, context);
  return { rows, buttons, run: (code) => vm.runInContext(code, context), context };
}

test("header controls expand and collapse both lists and expose accessible state", () => {
  const { rows, buttons, run } = harness();
  run("syncExpansionControls()");
  for (const kind of ["trigger", "artifact"]) {
    const button = buttons[`expand-${kind}`];
    assert.equal(button.disabled, false);
    button.click({ currentTarget: button });
    assert.equal(button.textContent, "Collapse all");
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.ok(rows.filter((r) => r.classList.contains(`${kind}-row`)).every((r) => r.getAttribute("aria-expanded") === "true"));
    button.click({ currentTarget: button });
    assert.equal(button.textContent, "Expand all");
  }
});

test("individual expansion is independent and survives row rerendering", () => {
  const { rows, run, context } = harness();
  context.first = rows[0];
  context.second = rows[1];
  context.artifact = rows[2];
  run("selectRow(first); selectRow(second); selectRow(artifact)");
  assert.equal(run("expandedRows.trigger.size"), 2);
  assert.match(run('triggerRow({id:1,event:"phase_end",phase:"repoingest"})'), /aria-expanded="true"/);
  assert.match(run('artifactRow({phase:"repoingest",key:"repo_root",state:"present"})'), /aria-expanded="true"/);
  run("selectRow(first)");
  assert.equal(rows[0].getAttribute("aria-expanded"), "false");
  assert.equal(rows[1].getAttribute("aria-expanded"), "true");
  assert.equal(rows[2].getAttribute("aria-expanded"), "true");
});

test("empty lists disable expansion controls", () => {
  const { rows, buttons, run } = harness();
  rows.length = 0;
  run("syncExpansionControls()");
  assert.equal(buttons["expand-trigger"].disabled, true);
  assert.equal(buttons["expand-artifact"].disabled, true);
});

test("authored interface strings are English and local fonts are valid assets", () => {
  for (const name of ["index.html", "details.html", "app.js", "details.js", "activity-demo.html", "motion-demo.html"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(staticDir, name), "utf8"), /\p{Script=Han}/u, name);
  }
  for (const name of ["Inter-Variable.ttf", "JetBrainsMono-Variable.ttf"]) {
    const bytes = fs.readFileSync(path.join(staticDir, "fonts", name));
    assert.ok(bytes.length > 100000, name);
    assert.equal(bytes.readUInt32BE(0), 0x00010000, name);
  }
});

test("monitor and details use the supplied paper logo and favicon", () => {
  for (const name of ["index.html", "details.html"]) {
    const html = fs.readFileSync(path.join(staticDir, name), "utf8");
    assert.match(html, /<img[^>]+src="\/static\/paper-logo\.png"[^>]+alt="MADE paper logo"/);
    assert.match(html, /rel="icon"[^>]+href="\/static\/paper-logo\.png"/);
  }
  const bytes = fs.readFileSync(path.join(staticDir, "paper-logo.png"));
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0);
});

test("paper logo motion is subtle, layout-neutral, and disabled for reduced motion", () => {
  const css = fs.readFileSync(path.join(staticDir, "workspace.css"), "utf8");
  assert.match(css, /animation: paper-logo-breathe 4s ease-in-out infinite/);
  assert.match(css, /@keyframes paper-logo-breathe\s*\{[\s\S]*?drop-shadow/);
  assert.match(css, /paper-logo:hover\s*\{\s*transform: scale\(1\.06\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*[^{}]*paper-logo[^{}]*\{\s*animation: none !important; transition: none !important;\s*transform: none !important; filter: none !important;/);
});

test("rollback history has an explicit accessible badge without changing current phase status", () => {
  const { run } = harness();
  run('dashboardData = {phases:[{phase:"weightresolve",status:"completed"}]}');
  const markup = run('phaseNode("weightresolve", 2, [{from:"apiadaptation",to:"weightresolve"}])');
  assert.match(markup, /phase-node completed has-rollback/);
  assert.match(markup, /class="rollback-icon"/);
  assert.match(markup, /class="rollback-label">Rollback/);
  assert.match(markup, /<strong>×1<\/strong>/);
  assert.match(markup, /Rollback history: 1 return to WeightResolve/);
  assert.doesNotMatch(run('phaseNode("repoingest", 1, [])'), /rollback-count/);
});

test("rollback events expose both source and destination and retain expansion", () => {
  const { run } = harness();
  run('expandedRows.trigger.add("rollback-8")');
  const markup = run('triggerRow({id:"rollback-8",event:"rollback",from:"apiadaptation",to:"weightresolve"})');
  assert.match(markup, /Rollback · APIAdaptation → WeightResolve/);
  assert.match(markup, /class="rollback-icon"/);
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, /APIAdaptation rolls back to WeightResolve/);
});
