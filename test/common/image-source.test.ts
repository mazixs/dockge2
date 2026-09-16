import { strict as assert } from "node:assert";
import test from "node:test";
import { registryOfImage, summariseRegistries } from "../../common/image-source";

test("реестр читается из самого имени образа", () => {
    assert.equal(registryOfImage("nginx"), "Docker Hub");
    assert.equal(registryOfImage("nginx:1.27-alpine"), "Docker Hub");
    // Имя с владельцем, но без хоста - это по-прежнему Docker Hub
    assert.equal(registryOfImage("traefik/whoami:latest"), "Docker Hub");
    assert.equal(registryOfImage("docker.io/library/redis:7"), "Docker Hub");
    assert.equal(registryOfImage("ghcr.io/immich-app/immich-server:v1.120.1"), "ghcr.io");
    assert.equal(registryOfImage("registry.gitlab.com/group/app:1.0"), "registry.gitlab.com");
    // Свой реестр с портом и localhost остаются хостами
    assert.equal(registryOfImage("localhost:5000/app:dev"), "localhost:5000");
    assert.equal(registryOfImage("localhost/app"), "localhost");
    assert.equal(registryOfImage(""), "");
});

test("сводка по реестрам считает и упорядочивает по частоте", () => {
    const summary = summariseRegistries([
        "ghcr.io/immich-app/immich-server:v1.120.1",
        "ghcr.io/immich-app/immich-machine-learning:v1.120.1",
        "tensorchord/pgvecto-rs:pg16",
        "redis:7-alpine",
        "",
    ]);

    assert.deepEqual(summary, [
        { registry: "Docker Hub",
            count: 2 },
        { registry: "ghcr.io",
            count: 2 },
    ]);
});

test("одинаковые счетчики упорядочены по имени, чтобы чип не прыгал", () => {
    const first = summariseRegistries([ "ghcr.io/a/b", "redis" ]);
    const second = summariseRegistries([ "redis", "ghcr.io/a/b" ]);
    assert.deepEqual(first, second);
});
