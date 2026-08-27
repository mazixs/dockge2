import { strict as assert } from "node:assert";
import test from "node:test";
import { parseDocument } from "yaml";
import {
    analyseComposeSource,
    applyStructuredEdit,
    canEditStructurally,
    listServiceNames,
    normaliseNetworks,
} from "../../common/compose-editor";

test("a plain compose file can be edited structurally", () => {
    const source = `# top comment
services:
  app:
    image: nginx # image comment
    ports:
      - "8080:80"
`;

    const analysis = analyseComposeSource(source);

    assert.deepEqual(analysis.errors, []);
    assert.deepEqual(analysis.unsupported, []);
    assert.equal(canEditStructurally(analysis), true);
    assert.equal(analysis.hasNetworksKey, false);
    assert.deepEqual(listServiceNames(analysis.config), [ "app" ]);
});

test("constructs that a rebuild would destroy switch the file to text mode", () => {
    const cases : Array<[string, string, string]> = [
        [ "include", "include:\n  - compose.base.yaml\nservices:\n  app:\n    image: nginx\n", "include" ],
        [ "custom tag", "services:\n  app:\n    image: nginx\n    volumes: !reset []\n", "!reset" ],
        [ "override tag", "services:\n  app:\n    command: !override [\"sh\"]\n", "!override" ],
        [ "anchor", "x-common: &common\n  restart: always\nservices:\n  app:\n    image: nginx\n", "anchor" ],
        [ "alias", "x-common: &common\n  restart: always\nservices:\n  app:\n    image: nginx\n    <<: *common\n", "alias" ],
        [ "inline merge key", "services:\n  app:\n    <<: {restart: always}\n    image: nginx\n", "merge key" ],
    ];

    for (const [ label, source, expected ] of cases) {
        const analysis = analyseComposeSource(source);
        assert.equal(canEditStructurally(analysis), false, `${label} must disable structured editing`);
        assert.ok(
            analysis.unsupported.some((reason) => reason.includes(expected)),
            `${label} should report ${expected}, got ${JSON.stringify(analysis.unsupported)}`,
        );
    }
});

test("a broken file reports errors instead of pretending to be editable", () => {
    const analysis = analyseComposeSource("services: [\n");

    assert.ok(analysis.errors.length > 0);
    assert.equal(canEditStructurally(analysis), false);
    assert.deepEqual(analysis.config, {});
});

test("an empty networks key is never introduced by the editor", () => {
    // The source has no networks key, so an empty edit keeps it out
    const withoutKey = normaliseNetworks({ services: {},
        networks: {} }, { sourceHadNetworks: false });
    assert.equal("networks" in withoutKey, false);

    // The user wrote the key themselves, so it survives an empty edit
    const keptKey = normaliseNetworks({ services: {},
        networks: {} }, { sourceHadNetworks: true });
    assert.deepEqual(keptKey["networks"], {});

    // Removing the last network explicitly does take the key out
    const removed = normaliseNetworks({ services: {},
        networks: {} }, { sourceHadNetworks: true,
        explicitNetworkRemoval: true });
    assert.equal("networks" in removed, false);

    // A real network is always written
    const withNetwork = normaliseNetworks({ services: {},
        networks: { internal: {} } }, { sourceHadNetworks: false });
    assert.deepEqual(withNetwork["networks"], { internal: {} });
});

test("a structured edit keeps comments, octal values and compose strings", () => {
    const source = `# stack comment
services:
  app:
    image: nginx # image comment
    restart: on-failure
    environment:
      ENABLED: yes
    tmpfs:
      mode: 01777
`;

    const analysis = analyseComposeSource(source);
    assert.equal(canEditStructurally(analysis), true);

    const config = analysis.config;
    (config["services"] as Record<string, Record<string, unknown>>)["app"]!["container_name"] = "app-1";

    const output = applyStructuredEdit(source, config, { sourceHadNetworks: analysis.hasNetworksKey });

    assert.match(output, /# stack comment/);
    assert.match(output, /# image comment/);
    assert.match(output, /mode: 01777/);
    assert.match(output, /container_name: app-1/);
    assert.equal(output.includes("networks:"), false);

    // The meaning of compose strings does not change
    const reparsed = parseDocument(output).toJS();
    assert.equal(reparsed.services.app.restart, "on-failure");
    assert.equal(reparsed.services.app.environment.ENABLED, "yes");
});

test("legacy octal is restored without touching neighbouring lines", () => {
    const source = `services:
  app:
    image: nginx
    environment:
      ENABLED: yes
      DISABLED: no
    tmpfs:
      mode: 01777
    other:
      mode: 007
`;

    const analysis = analyseComposeSource(source);
    const config = analysis.config;
    (config["services"] as Record<string, Record<string, unknown>>)["app"]!["container_name"] = "app-1";

    const output = applyStructuredEdit(source, config, { sourceHadNetworks: analysis.hasNetworksKey });

    // The octal values keep their exact text, including the short one
    assert.match(output, /mode: 01777/);
    assert.match(output, /mode: 007/);

    // And the untouched lines are not rewritten, no quotes appear around yes and no
    assert.match(output, /ENABLED: yes/);
    assert.match(output, /DISABLED: no/);
    assert.equal(output.includes("ENABLED: \"yes\""), false);
    assert.match(output, /container_name: app-1/);
});

test("an octal value the user actually changed is written as the new value", () => {
    const source = "services:\n  app:\n    image: nginx\n    tmpfs:\n      mode: 01777\n";
    const analysis = analyseComposeSource(source);
    const config = analysis.config;

    // The editor sets a different number, so the old text must not come back
    ((config["services"] as Record<string, Record<string, Record<string, unknown>>>)["app"]!["tmpfs"] as Record<string, unknown>)["mode"] = 493;

    const output = applyStructuredEdit(source, config, { sourceHadNetworks: false });

    assert.match(output, /mode: 493/);
    assert.equal(output.includes("01777"), false);
});

test("an edit keeps the formatting of the file", () => {
    // Four space indentation and comments inside a sequence
    const source = `services:
    app:
        image: nginx
        ports:
            # web
            - "8080:80" # http
            - "8443:443"
`;

    const analysis = analyseComposeSource(source);
    const config = analysis.config;
    const app = (config["services"] as Record<string, Record<string, unknown>>)["app"]!;

    // The user edits the second port only
    (app["ports"] as string[])[1] = "9443:443";

    const output = applyStructuredEdit(source, config, { sourceHadNetworks: false });

    // The untouched item keeps its comments, the edited one changed
    assert.match(output, /# web/);
    assert.match(output, /- "8080:80" # http/);
    assert.match(output, /9443:443/);

    // And the indentation of the file is not switched to two spaces
    assert.match(output, /\n {4}app:/);
});

test("appending and removing sequence items keeps the neighbours", () => {
    const source = "services:\n  app:\n    image: nginx\n    ports:\n      - \"8080:80\" # keep\n";
    const analysis = analyseComposeSource(source);
    const app = (analysis.config["services"] as Record<string, Record<string, unknown>>)["app"]!;

    (app["ports"] as string[]).push("9090:90");

    const added = applyStructuredEdit(source, analysis.config, { sourceHadNetworks: false });
    assert.match(added, /- "8080:80" # keep/);
    assert.match(added, /9090:90/);

    const second = analyseComposeSource(added);
    const secondApp = (second.config["services"] as Record<string, Record<string, unknown>>)["app"]!;
    (secondApp["ports"] as string[]).pop();

    const removed = applyStructuredEdit(added, second.config, { sourceHadNetworks: false });
    assert.match(removed, /- "8080:80" # keep/);
    assert.equal(removed.includes("9090:90"), false);
});

test("a numeric key is edited in place instead of being duplicated", () => {
    const source = "x-ports:\n  8080: first\n  9090: second\nservices:\n  app:\n    image: nginx\n";
    const analysis = analyseComposeSource(source);
    const config = analysis.config;

    (config["x-ports"] as Record<string, unknown>)["8080"] = "changed";

    const output = applyStructuredEdit(source, config, { sourceHadNetworks: false });

    assert.match(output, /8080: changed/);
    assert.equal(output.includes("first"), false);

    // Exactly one key, not the old numeric one plus a new string one
    assert.equal(output.split("8080").length - 1, 1);
    assert.match(output, /9090: second/);

    // Deleting it removes the key for real
    const second = analyseComposeSource(output);
    delete (second.config["x-ports"] as Record<string, unknown>)["8080"];
    const deleted = applyStructuredEdit(output, second.config, { sourceHadNetworks: false });
    assert.equal(deleted.includes("8080"), false);
    assert.match(deleted, /9090: second/);
});

test("windows line endings survive an edit", () => {
    const source = "services:\r\n  app:\r\n    image: nginx\r\n";
    const analysis = analyseComposeSource(source);
    (analysis.config["services"] as Record<string, Record<string, unknown>>)["app"]!["restart"] = "always";

    const output = applyStructuredEdit(source, analysis.config, { sourceHadNetworks: false });

    assert.match(output, /restart: always/);
    assert.equal(output.includes("\r\n"), true);
    assert.equal(/[^\r]\n/.test(output), false, "no bare LF may be left behind");
});
