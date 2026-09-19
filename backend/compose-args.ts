/**
 * Arguments of one `docker compose` call.
 *
 * Two places build them: the stack itself, and the isolated check of a Git result
 * before anything is written. They must select the same project - the same compose
 * file, the same env files, in the same order - or the check passes on a project
 * that is not the one the user then starts. Only the isolation differs, and it is
 * a parameter here rather than a second copy of the assembly.
 */
export interface ComposeCall {
    /** Selected compose file, relative to the directory the command runs in */
    composeFileName : string;
    /** CLI env files in the configured order, relative to the same directory */
    envFileNames : string[];
    /**
     * Shared env file of the stacks directory, empty when there is none.
     * The caller resolves it, because how strictly it is checked depends on who
     * is asking: running the user's own project and validating files from a
     * repository do not trust the same things.
     */
    globalEnvFile : string;
    /** Project name for a call that must stay out of the user's running project */
    projectName? : string;
}

/**
 * Build the argument array of a `docker compose` call.
 *
 * Every name is prefixed with `./`, so a file called `-f` stays a file name and
 * never becomes an option. This returns an array and never a shell string.
 * @param call What the call is about
 * @param command Compose sub command
 * @param extraOptions Arguments of the sub command
 * @returns Argument array in the order Compose reads it
 */
export function composeArgs(call : ComposeCall, command : string, ...extraOptions : string[]) : string[] {
    const args = [ "compose" ];

    if (call.projectName) {
        args.push("--project-name", call.projectName);
    }

    // The global env file stays the outermost source, stack files override it
    if (call.globalEnvFile) {
        args.push("--env-file", call.globalEnvFile);
    }

    for (const fileName of call.envFileNames) {
        args.push("--env-file", "./" + fileName);
    }

    if (call.composeFileName) {
        args.push("-f", call.composeFileName);
    }

    args.push(command, ...extraOptions);
    return args;
}
