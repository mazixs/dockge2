import { Database } from "../database";
import { LooseObject } from "../../common/util-common";

interface AgentRow {
    id: number;
    url: string;
    username: string;
    password: string;
    name?: string | null;
    active: number;
}

export class Agent {
    id!: number;
    url!: string;
    username!: string;
    password!: string;
    name?: string | null;
    active!: number;

    constructor(row?: Partial<AgentRow>) {
        if (row) {
            Object.assign(this, row);
        }
    }

    private static fromRow(row?: AgentRow | null) : Agent | null {
        return row ? new Agent(row) : null;
    }

    static async findByUrl(url: string) : Promise<Agent | null> {
        const row = await Database.getKnex()("agent").where("url", url).first();
        return Agent.fromRow(row);
    }

    static async getAgentList() : Promise<Record<string, Agent>> {
        const list = await Database.getKnex()("agent");
        const result : Record<string, Agent> = {};
        for (const row of list) {
            const agent = Agent.fromRow(row);
            if (agent) {
                result[agent.endpoint] = agent;
            }
        }
        return result;
    }

    static async create(url: string, username: string, password: string, name: string) : Promise<Agent> {
        await Database.getKnex()("agent").insert({
            url,
            username,
            password,
            name,
        });

        const agent = await Agent.findByUrl(url);
        if (!agent) {
            throw new Error("Failed to create agent");
        }
        return agent;
    }

    static async deleteByUrl(url: string) : Promise<Agent | null> {
        const agent = await Agent.findByUrl(url);
        if (agent) {
            await Database.getKnex()("agent").where("id", agent.id).delete();
        }
        return agent;
    }

    static async updateName(url: string, name: string) : Promise<Agent | null> {
        const agent = await Agent.findByUrl(url);
        if (agent) {
            await Database.getKnex()("agent").where("id", agent.id).update({ name });
            agent.name = name;
        }
        return agent;
    }

    get endpoint() : string {
        const obj = new URL(this.url);
        return obj.host;
    }

    toJSON() : LooseObject {
        return {
            url: this.url,
            username: this.username,
            endpoint: this.endpoint,
            name: this.name,
        };
    }

}

export default Agent;
