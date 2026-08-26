/**
 * A Compose secret bound to a file of the stack directory.
 * Only the mapping is stored, never the content.
 */
export interface SecretBinding {
    /** Compose secret name, for example "db_password" */
    name : string;
    /** File inside the stack directory, for example ".secret.db" */
    fileName : string;
    /** Services that reference this secret in the compose file */
    services : string[];
}

/**
 * Which files of a stack directory Dockge uses.
 * The texts themselves stay in the files, this is only the selection and the order.
 */
export interface StackFileConfig {
    /** Compose file passed to every `docker compose` call through `-f` */
    composeFileName : string;
    /** Ordered CLI env files used for compose interpolation */
    envFileNames : string[];
    /** Env file that the UI shows and edits, empty when the stack has none */
    activeEnvFileName : string;
    secretBindings : SecretBinding[];
}

/**
 * Metadata of a secret file, without its content
 */
export interface SecretFileMeta {
    fileName : string;
    /** Compose secret name when the file is bound, empty otherwise */
    secretName : string;
    size : number;
    /** ISO timestamp of the last modification */
    modifiedAt : string;
    /** Services that reference the secret in the compose file */
    services : string[];
}

/**
 * What Dockge found in the stack directory plus the configuration in use
 */
export interface StackFileInventory {
    config : StackFileConfig;
    composeFileNames : string[];
    envFileNames : string[];
    secretFiles : SecretFileMeta[];
    /**
     * True when the directory holds more than one compose file and nobody picked one yet.
     * The server keeps using a deterministic choice, but the UI has to ask.
     */
    needsComposeSelection : boolean;
}
