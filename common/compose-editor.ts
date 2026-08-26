import { Document, isAlias, isMap, isNode, isPair, isScalar, isSeq, parseDocument, visit } from "yaml";
import { LooseObject } from "./util-common";

/**
 * Why a compose file is being written.
 * Only an explicit edit may change the source text, a refresh never does.
 */
export type EditOrigin = "raw-edit" | "structured-edit" | "external-refresh";

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

    applyDiff(doc, [], current, next);

    // YAML 1.2 reads `01777` as decimal 1777, so the original notation has to be restored
    if (preserveLegacyOctal(doc)) {
        doc.setSchema("1.1");
    }

    return doc.toString({ flowCollectionPadding: false });
}

/**
 * Restore values written as legacy octal, such as `mode: 01777`
 * @param doc Document to fix in place
 * @returns Whether any legacy octal value was found
 */
export function preserveLegacyOctal(doc : Document) : boolean {
    let found = false;

    visit(doc, (_key, node) => {
        if (
            isScalar(node) &&
            typeof node.value === "number" &&
            typeof node.source === "string" &&
            /^0[0-7]+$/.test(node.source)
        ) {
            node.value = Number.parseInt(node.source, 8);
            node.format = "OCT";
            found = true;
        }
    });

    return found;
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
            doc.deleteIn([ ...path, key ]);
        }
    }

    for (const key of Object.keys(next)) {
        const nextValue = next[key];
        const currentValue = current[key];
        const childPath = [ ...path, key ];

        if (!(key in current)) {
            doc.setIn(childPath, nextValue);
            continue;
        }

        if (isPlainObject(currentValue) && isPlainObject(nextValue)) {
            applyDiff(doc, childPath, currentValue, nextValue);
            continue;
        }

        // Scalars and sequences are replaced as a whole, but only when they differ
        if (JSON.stringify(currentValue) !== JSON.stringify(nextValue)) {
            doc.setIn(childPath, nextValue);
        }
    }
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

/**
 * Whether a document contains a sequence node at the given path.
 * Small helper for structured edits that append to a list.
 * @param doc Document to inspect
 * @param path Node path
 * @returns True when the node exists and is a sequence
 */
export function hasSequenceAt(doc : Document, path : readonly unknown[]) : boolean {
    return isSeq(doc.getIn(path));
}
