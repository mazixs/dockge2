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
