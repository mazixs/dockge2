import { strict as assert } from "node:assert";
import test from "node:test";
import { readStackRelations, relationsFromCompose, relationsFromContainer, type RelationsDocker } from "../../backend/stack-relations";
import { ValidationError } from "../../backend/util-server";

const WEB = "a1".repeat(32);
const DB = "b2".repeat(32);

/** Two containers of the project, as `docker ps --format json` prints them */
const PS = [
    { ID: WEB,
        Names: "shop-web-1",
        Labels: "com.docker.compose.project=shop,com.docker.compose.service=web" },
    { ID: DB,
        Names: "shop-db-1",
        Labels: "com.docker.compose.project=shop,com.docker.compose.service=db" },
    { ID: "short",
        Names: "broken",
        Labels: "" },
].map((row) => JSON.stringify(row)).join("\n");

/** The resolved model `docker compose config --format json` prints, environment included */
const MODEL = {
    name: "shop",
    services: {
        db: { image: "postgres:16",
            environment: { POSTGRES_PASSWORD: "hunter2" },
            networks: { backend: null },
            volumes: [{ type: "volume",
                source: "data",
                target: "/var/lib/postgresql/data" }],
            secrets: [{ source: "db_password",
                target: "/run/secrets/db_password" }] },
        web: { image: "nginx",
            depends_on: { db: { condition: "service_healthy",
                required: true } },
            networks: { backend: null,
                default: null },
            ports: [{ mode: "ingress",
                target: 80,
                published: "8080",
                protocol: "tcp" }, { target: 9000 }],
            volumes: [{ type: "bind",
                source: "/srv/shop/html",
                target: "/usr/share/nginx/html",
                read_only: true }] },
        worker: { image: "alpine",
            depends_on: [ "db" ] },
    },
};

test("a stack of this panel is read from the model Compose resolves, and nothing of the environment leaves", async () => {
    const calls : { args : string[]; cwd : string | undefined }[] = [];
    const docker : RelationsDocker = async (args, cwd) => {
        calls.push({ args,
            cwd });
        return args[0] === "ps" ? PS : JSON.stringify(MODEL);
    };

    const relations = await readStackRelations({ project: "shop",
        containerLabel: "com.docker.compose.project.working_dir=/opt/stacks/shop",
        composeConfigArgs: [ "compose", "-f", "compose.yaml", "config", "--format", "json" ],
        cwd: "/opt/stacks/shop" }, docker);

    assert.equal(relations.source, "compose");
    assert.deepEqual(relations.services.map((service) => service.name), [ "db", "web", "worker" ], "a stopped service counts too");
    const [ db, web, worker ] = relations.services;
    assert.deepEqual(web?.dependsOn, [{ service: "db",
        condition: "service_healthy" }]);
    assert.deepEqual(web?.networks, [ "backend", "default" ]);
    assert.deepEqual(web?.ports, [{ published: "8080",
        target: "80",
        protocol: "tcp",
        hostIp: "" }, { published: "",
        target: "9000",
        protocol: "tcp",
        hostIp: "" }]);
    assert.deepEqual(web?.volumes, [{ type: "bind",
        source: "/srv/shop/html",
        target: "/usr/share/nginx/html",
        readOnly: true }]);
    assert.deepEqual(web?.containers, [{ id: WEB,
        name: "shop-web-1" }]);
    assert.deepEqual(db?.secrets, [ "db_password" ]);
    assert.deepEqual(worker?.dependsOn, [{ service: "db",
        condition: "service_started" }]);
    assert.deepEqual(worker?.containers, []);
    assert.doesNotMatch(JSON.stringify(relations), /hunter2|POSTGRES_PASSWORD/);

    assert.deepEqual(calls[0]?.args, [ "ps", "--all", "--no-trunc", "--filter", "label=com.docker.compose.project.working_dir=/opt/stacks/shop", "--format", "json" ]);
    assert.equal(calls[1]?.cwd, "/opt/stacks/shop");
});

test("a project the panel does not manage is read from its containers, never from its files", async () => {
    const inspect = [
        { Id: WEB,
            Config: { Labels: { "com.docker.compose.service": "web",
                "com.docker.compose.depends_on": "db:service_healthy:false,cache:service_started:true" },
            Env: [ "TOKEN=hunter2" ] },
            NetworkSettings: { Networks: { shop_default: {},
                proxy: {} },
            Ports: { "80/tcp": [{ HostIp: "0.0.0.0",
                HostPort: "8080" }, { HostIp: "::",
                HostPort: "8080" }],
            "443/tcp": null } },
            Mounts: [{ Type: "bind",
                Source: "/srv/secret.txt",
                Destination: "/run/secrets/api_key",
                RW: false }, { Type: "volume",
                Name: "shop_html",
                Source: "/var/lib/docker/volumes/shop_html/_data",
                Destination: "/html",
                RW: true }] },
        { Id: DB,
            Config: { Labels: { "com.docker.compose.service": "db" } },
            NetworkSettings: { Networks: { shop_default: {} } } },
    ];
    const asked : string[][] = [];
    const docker : RelationsDocker = async (args) => {
        asked.push(args);
        return args[0] === "ps" ? PS : JSON.stringify(inspect);
    };

    const relations = await readStackRelations({ project: "shop",
        containerLabel: "com.docker.compose.project=shop",
        composeConfigArgs: null,
        cwd: "" }, docker);

    assert.equal(relations.source, "docker");
    assert.ok(!asked.some((args) => args.includes("config")), "Compose is not asked to read somebody else's files");
    assert.deepEqual(asked[1], [ "inspect", "--type", "container", DB, WEB ], "only well-formed ids reach Docker");
    const web = relations.services.find((service) => service.name === "web");
    assert.deepEqual(web?.dependsOn.map((item) => `${item.service}:${item.condition}`), [ "db:service_healthy", "cache:service_started" ]);
    assert.deepEqual(web?.networks, [ "proxy", "shop_default" ]);
    assert.deepEqual(web?.ports.map((port) => `${port.hostIp}:${port.published}->${port.target}/${port.protocol}`), [ "0.0.0.0:8080->80/tcp", ":::8080->80/tcp", ":->443/tcp" ]);
    assert.deepEqual(web?.secrets, [ "api_key" ]);
    assert.deepEqual(web?.volumes, [{ type: "volume",
        source: "shop_html",
        target: "/html",
        readOnly: false }]);
    assert.doesNotMatch(JSON.stringify(relations), /hunter2/);
});

test("a model or a Docker that cannot be read is said so, without quoting what Compose printed", async () => {
    const target = { project: "shop",
        containerLabel: "com.docker.compose.project=shop",
        composeConfigArgs: [ "compose", "config", "--format", "json" ],
        cwd: "/opt/stacks/shop" };
    const failing : RelationsDocker = async (args) => {
        if (args[0] === "ps") {
            return "";
        }
        throw new Error("invalid interpolation: PASSWORD=hunter2");
    };
    await assert.rejects(readStackRelations(target, failing), (e : Error) => e instanceof ValidationError && e.message === "relationsUnavailable");
    await assert.rejects(readStackRelations(target, async () => {
        throw new Error("Cannot connect to the Docker daemon");
    }), /relationsUnavailable/);
});

test("odd shapes in a model or an inspect answer give empty relations, not a crash", () => {
    assert.deepEqual(relationsFromCompose("x", { depends_on: "db",
        networks: 3,
        ports: "80",
        secrets: [ 7, { source: "" }] }), { name: "x",
        dependsOn: [],
        networks: [],
        ports: [],
        volumes: [],
        secrets: [],
        containers: [] });
    assert.deepEqual(relationsFromContainer({}), { name: "",
        dependsOn: [],
        networks: [],
        ports: [],
        volumes: [],
        secrets: [],
        containers: [] });
});
