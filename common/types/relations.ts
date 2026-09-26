/** A port a service publishes or exposes */
export interface RelationPort {
    /** Port on the host, empty when it is only exposed to other containers */
    published : string;
    target : string;
    protocol : string;
    /** Host address it is bound to, empty for every address */
    hostIp : string;
}

/** A volume, bind mount or tmpfs of a service */
export interface RelationVolume {
    type : string;
    /** Volume name or host path, empty for an anonymous volume or tmpfs */
    source : string;
    target : string;
    readOnly : boolean;
}

/**
 * How one service is tied to the rest, read from what Compose or Docker actually has,
 * never guessed from names. Environment and secret content are deliberately absent.
 */
export interface ServiceRelations {
    name : string;
    /** Services it waits for, with the condition Compose waits on */
    dependsOn : { service : string; condition : string }[];
    networks : string[];
    ports : RelationPort[];
    volumes : RelationVolume[];
    /** Names of the Compose secrets it receives */
    secrets : string[];
    /** Containers that currently belong to the service, by full id */
    containers : { id : string; name : string }[];
}

export interface StackRelations {
    /**
     * `compose` - the resolved model of the stack's own files, stopped services included;
     * `docker` - a project the panel does not manage, read from its containers
     */
    source : "compose" | "docker";
    services : ServiceRelations[];
}
