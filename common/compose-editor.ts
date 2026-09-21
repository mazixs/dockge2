import { Document, isAlias, isMap, isNode, isPair, isScalar, parseDocument, visit } from "yaml";
import { LooseObject } from "./util-common";

/**
 * Why a compose file is being written.
 * Only an explicit edit may change the source text, a refresh never does.
 */
export type EditOrigin = "raw-edit" | "structured-edit" | "external-refresh";

/**
 * A compose file as an object, the way the screens hold it.
 *
 * Only the keys the interface reads are named. A compose file carries much more, and
 * the editor writes it back through its source rather than through this object, so
 * what is not named here is kept rather than described.
 */
export interface ComposeModel {
    services? : Record<string, { image? : string, ports? : unknown[], container_name? : string, [key : string] : unknown }>;
    networks? : Record<string, LooseObject> | null;
    /** Dockge's own extension: the links a stack declares */
    "x-dockge"? : { urls? : unknown };
    [key : string] : unknown;
}

export interface ComposeAnalysis {
    /** Parsed source document, used as the base of every round-trip edit */
    doc : Document;
    /** Plain object view for the structured editor */
    config : LooseObject;
    /** YAML parse errors, empty when the source is valid */
    errors : string[];
    /**
     * Constructs the structured editor cannot rebuild without changing meaning.
     * While this is not empty the UI must stay in text mode.
     */
    unsupported : string[];
    /** Whether the source declares a top level `networks` key */
    hasNetworksKey : boolean;
}

/**
 * Standard YAML tags that survive a rebuild, anything else is a custom tag
 */
const KNOWN_TAG_PREFIXES = [ "tag:yaml.org,2002:" ];

/**
 * Look at a compose source and report what can be done with it safely
 * @param source Compose file content
 * @returns Analysis of the source
 */
export function analyseComposeSource(source : string) : ComposeAnalysis {
    const doc = parseDocument(source, { keepSourceTokens: true });
    const errors = doc.errors.map((error) => error.message);

    const unsupported : string[] = [];
    const addUnsupported = (reason : string) => {
        if (!unsupported.includes(reason)) {
            unsupported.push(reason);
        }
    };

    if (errors.length === 0) {
        // Compose `include` pulls in other files, a rebuild of this file would drop it
        if (isMap(doc.contents) && doc.hasIn([ "include" ])) {
            addUnsupported("include");
        }

        visit(doc, (_key, node) => {
            if (!isNode(node)) {
                return;
            }

            if (isAlias(node)) {
                addUnsupported("alias");
                return;
            }

            if (node.anchor) {
                addUnsupported("anchor");
            }

            const tag = node.tag;
            if (typeof tag === "string" && !KNOWN_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix))) {
                addUnsupported(tag);
            }
        });

        // Merge keys (<<) are resolved on parse, so a rebuild would inline them
        visit(doc, {
            Pair(_key, pair) {
                if (isPair(pair) && isScalar(pair.key) && pair.key.value === "<<") {
                    addUnsupported("merge key");
                }
            },
        });
    }

    let config : LooseObject = {};

    if (errors.length === 0) {
        try {
            config = (doc.toJS() ?? {}) as LooseObject;
        } catch (e) {
            errors.push(e instanceof Error ? e.message : String(e));
        }
    }

    return {
        doc,
        config,
        errors,
        unsupported,
        hasNetworksKey: isMap(doc.contents) && doc.hasIn([ "networks" ]),
    };
}

/**
 * Whether the structured editor may write this file back
 * @param analysis Analysis of the source
 * @returns True when a rebuild keeps the meaning of the file
 */
export function canEditStructurally(analysis : ComposeAnalysis) : boolean {
    return analysis.errors.length === 0 && analysis.unsupported.length === 0;
}

export interface StructuredEditOptions {
    /** Whether the source itself declared a top level `networks` key */
    sourceHadNetworks : boolean;
    /** Set when the user explicitly removed the last network */
    explicitNetworkRemoval? : boolean;
}

/**
 * Apply a structured edit to the original document.
 * Only the values that really changed are touched, so comments, quoting style,
 * legacy octal numbers and the order of untouched keys survive.
 * @param source Original compose text
 * @param config Edited plain object
 * @param options How to treat an empty networks key
 * @returns New compose text
 */
export function applyStructuredEdit(source : string, config : LooseObject, options : StructuredEditOptions) : string {
    const doc = parseDocument(source, { keepSourceTokens: true });
    const current = (doc.toJS() ?? {}) as LooseObject;
    const next = normaliseNetworks(config, options);

    // Where the source used legacy octal, remember the exact text before anything is written
    const octalByPath = collectLegacyOctal(doc);

    applyDiff(doc, [], current, next);

    // Keep the formatting of the file: the indentation the user writes and their line endings
    const output = withSourceLineEndings(source, doc.toString({
        flowCollectionPadding: false,
        indent: detectIndent(source),
    }));

    // YAML 1.2 prints `01777` as `1777`, so the original text is put back.
    // Switching the whole document to YAML 1.1 would fix the octal but quote every
    // `yes`/`no`/`on`/`off` in the file, which are lines the user never touched.
    return restoreLegacyOctal(output, octalByPath);
}

/**
 * Serialise an edited document the way applyStructuredEdit() does.
 * Exported for callers that already hold a document, such as the secret binding.
 * @param source Original compose text
 * @param doc Edited document
 * @returns New compose text
 */
export function serialiseEditedDocument(source : string, doc : Document) : string {
    return withSourceLineEndings(source, doc.toString({
        flowCollectionPadding: false,
        indent: detectIndent(source),
    }));
}

/**
 * Read the indentation width of a compose file, so an edit does not reformat it
 * @param source Compose file content
 * @returns Indentation width, two spaces when it cannot be determined
 */
function detectIndent(source : string) : number {
    for (const line of source.split("\n")) {
        const match = /^( +)\S/.exec(line);

        if (match?.[1]) {
            return match[1].length;
        }
    }

    return 2;
}

/**
 * Restore the line endings of the source, because the serialiser always writes LF
 * @param source Original compose file content
 * @param output Serialised YAML
 * @returns Serialised YAML with the original line endings
 */
function withSourceLineEndings(source : string, output : string) : string {
    return source.includes("\r\n") ? output.replace(/\r?\n/g, "\r\n") : output;
}

/**
 * Find the values written as legacy octal, such as `mode: 01777`
 * @param doc Parsed source document
 * @returns Original text per node path
 */
function collectLegacyOctal(doc : Document) : Map<string, string> {
    const result = new Map<string, string>();

    visit(doc, (key, node, path) => {
        if (
            !isScalar(node) ||
            typeof node.value !== "number" ||
            typeof node.source !== "string" ||
            !/^0[0-7]+$/.test(node.source)
        ) {
            return;
        }

        const nodePath = toNodePath(key, path);

        if (nodePath) {
            result.set(JSON.stringify(nodePath), node.source);
        }
    });

    return result;
}

/**
 * Put the original octal text back into a serialised document
 * @param output Serialised YAML
 * @param octalByPath Original text per node path
 * @returns YAML with the original octal notation
 */
function restoreLegacyOctal(output : string, octalByPath : Map<string, string>) : string {
    if (octalByPath.size === 0) {
        return output;
    }

    const doc = parseDocument(output);
    const edits : Array<{ start : number, end : number, text : string }> = [];

    for (const [ pathKey, text ] of octalByPath) {
        const nodePath = JSON.parse(pathKey) as Array<string | number>;
        const node = doc.getIn(nodePath, true);

        // Only a value that is still the same number is replaced, an edited one stays edited
        if (isScalar(node) && node.range && typeof node.value === "number" && node.value === Number.parseInt(text, 10)) {
            edits.push({ start: node.range[0],
                end: node.range[1],
                text });
        }
    }

    // Later edits first, so earlier offsets stay valid
    edits.sort((a, b) => b.start - a.start);

    let result = output;

    for (const edit of edits) {
        result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    }

    return result;
}

/**
 * Build the key path of a node from the visitor path
 * @param key Key of the node inside its parent
 * @param path Ancestors of the node
 * @returns Path usable with Document.getIn(), or null when it cannot be built
 */
function toNodePath(key : unknown, path : readonly unknown[]) : Array<string | number> | null {
    const result : Array<string | number> = [];

    for (const ancestor of path) {
        if (isPair(ancestor)) {
            if (!isScalar(ancestor.key) || typeof ancestor.key.value !== "string") {
                return null;
            }
            result.push(ancestor.key.value);
        }
    }

    // A sequence entry is addressed by its index, a map value by nothing extra
    if (typeof key === "number") {
        result.push(key);
    }

    return result;
}

/**
 * Check whether a value is a plain object that can be merged key by key
 * @param value Value to check
 * @returns True for a plain object
 */
function isPlainObject(value : unknown) : value is LooseObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Write the difference between two plain objects into a document
 * @param doc Document to edit in place
 * @param path Path of the object inside the document
 * @param current Values currently in the document
 * @param next Values the editor wants
 */
function applyDiff(doc : Document, path : readonly unknown[], current : LooseObject, next : LooseObject) : void {
    for (const key of Object.keys(current)) {
        if (!(key in next)) {
            doc.deleteIn([ ...path, resolveMapKey(doc, path, key) ]);
        }
    }

    for (const key of Object.keys(next)) {
        const nextValue = next[key];
        const currentValue = current[key];

        // `doc.toJS()` turns every key into a string, but the document may hold a number.
        // Using the string would add a second key instead of editing the existing one.
        const childPath = [ ...path, resolveMapKey(doc, path, key) ];

        if (!(key in current)) {
            doc.setIn(childPath, nextValue);
            continue;
        }

        if (isPlainObject(currentValue) && isPlainObject(nextValue)) {
            applyDiff(doc, childPath, currentValue, nextValue);
            continue;
        }

        if (Array.isArray(currentValue) && Array.isArray(nextValue)) {
            applyArrayDiff(doc, childPath, currentValue, nextValue);
            continue;
        }

        // Scalars are replaced, but only when they differ
        if (JSON.stringify(currentValue) !== JSON.stringify(nextValue)) {
            doc.setIn(childPath, nextValue);
        }
    }
}

/**
 * Write the difference between two arrays item by item.
 * Replacing the whole sequence would drop the comments of items nobody edited,
 * which happens on every keystroke in a ports or volumes field.
 * @param doc Document to edit in place
 * @param path Path of the sequence inside the document
 * @param current Items currently in the document
 * @param next Items the editor wants
 */
function applyArrayDiff(doc : Document, path : readonly unknown[], current : readonly unknown[], next : readonly unknown[]) : void {
    if (JSON.stringify(current) === JSON.stringify(next)) {
        return;
    }

    // Items removed from the end go first, so the remaining indexes stay valid
    for (let index = current.length - 1; index >= next.length; index--) {
        doc.deleteIn([ ...path, index ]);
    }

    for (let index = 0; index < next.length; index++) {
        const nextItem = next[index];
        const currentItem = current[index];

        if (index >= current.length) {
            doc.addIn(path, nextItem);
            continue;
        }

        if (JSON.stringify(currentItem) === JSON.stringify(nextItem)) {
            continue;
        }

        if (isPlainObject(currentItem) && isPlainObject(nextItem)) {
            applyDiff(doc, [ ...path, index ], currentItem, nextItem);
            continue;
        }

        doc.setIn([ ...path, index ], nextItem);
    }
}

/**
 * Find the key the document really uses for a stringified key.
 * A compose file may hold numeric keys, for example inside `x-` extensions.
 * @param doc Document being edited
 * @param path Path of the map
 * @param key Key as it appears in the plain object
 * @returns The key value to use with getIn/setIn/deleteIn
 */
function resolveMapKey(doc : Document, path : readonly unknown[], key : string) : string | number {
    const node = path.length === 0 ? doc.contents : doc.getIn(path, true);

    if (!isMap(node)) {
        return key;
    }

    for (const item of node.items) {
        if (isScalar(item.key) && typeof item.key.value !== "string" && String(item.key.value) === key) {
            return item.key.value as number;
        }
    }

    return key;
}

/**
 * Drop or keep an empty `networks` key according to what the source had.
 * A key that was never in the file stays out of it, an explicit removal takes it out,
 * and a key the user wrote themselves is preserved.
 * @param config Edited plain object
 * @param options How to treat an empty networks key
 * @returns Object to serialise
 */
export function normaliseNetworks(config : LooseObject, options : StructuredEditOptions) : LooseObject {
    const next : LooseObject = { ...config };
    const networks = next["networks"];
    const isEmpty = !networks || (typeof networks === "object" && Object.keys(networks as object).length === 0);

    if (!isEmpty) {
        return next;
    }

    if (options.explicitNetworkRemoval || !options.sourceHadNetworks) {
        delete next["networks"];
    } else {
        next["networks"] = networks ?? {};
    }

    return next;
}

/**
 * Collect the service names of a parsed compose document
 * @param config Plain object view of the compose file
 * @returns Service names
 */
export function listServiceNames(config : LooseObject) : string[] {
    const services = config["services"];

    if (!services || typeof services !== "object" || Array.isArray(services)) {
        return [];
    }

    return Object.keys(services as object);
}

