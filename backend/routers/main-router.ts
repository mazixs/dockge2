import { DockgeServer } from "../dockge-server";
import { Database } from "../database";
import packageJSON from "../../package.json";
import { Router } from "../router";
import express, { Express, Router as ExpressRouter } from "express";

export class MainRouter extends Router {
    create(app: Express, server: DockgeServer): ExpressRouter {
        const router = express.Router();

        router.get("/", (req, res) => {
            // Страница ссылается на хешированные ассеты и сама имени не меняет:
            // без перепроверки браузер после обновления панели открыл бы старую
            // разметку с мертвыми ссылками
            res.set("Cache-Control", "no-cache");
            res.send(server.indexHTML);
        });

        router.get("/health/ready", async (_req, res) => {
            const ready = await server.readiness.check(() => server.resources.stopping, async () => {
                // Both tables must exist after application and auth migrations.
                await Database.getKnex().raw("SELECT (SELECT count(*) FROM setting), (SELECT count(*) FROM user)").timeout(1200);
            });
            res.set("Cache-Control", "no-store");
            res.status(ready ? 200 : 503).json({ service: "dockge2",
                protocol: 1,
                ready,
                version: packageJSON.version });
        });

        // Robots.txt
        router.get("/robots.txt", async (_request, response) => {
            let txt = "User-agent: *\nDisallow: /";
            response.setHeader("Content-Type", "text/plain");
            response.send(txt);
        });

        return router;
    }

}
