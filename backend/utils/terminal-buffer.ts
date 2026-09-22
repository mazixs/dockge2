/** Bounded replay; live terminal output is never dropped by this buffer. */
export class TerminalBuffer {
    private chunks : { text : string; bytes : number }[] = [];
    private used = 0;
    private truncated = false;

    constructor(private maxBytes = 1024 * 1024, private maxChunks = 100) {}

    /** Retained UTF-8 payload bytes. */
    get bytes() : number {
        return this.used;
    }

    /** Append a chunk, retaining only a valid UTF-8 tail if it exceeds the budget. */
    pushItem(text : string) : void {
        let bytes = Buffer.byteLength(text);
        if (bytes > this.maxBytes) {
            const buffer = Buffer.from(text);
            let start = buffer.length - this.maxBytes;
            while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) {
                start++;
            }
            text = buffer.subarray(start).toString("utf8");
            bytes = Buffer.byteLength(text);
            this.truncated = true;
        }
        this.chunks.push({ text,
            bytes });
        this.used += bytes;
        while (this.used > this.maxBytes || this.chunks.length > this.maxChunks) {
            this.used -= this.chunks.shift()!.bytes;
            this.truncated = true;
        }
    }

    /** Replay discloses omitted output instead of presenting the tail as complete. */
    read() : string {
        return (this.truncated ? "[Earlier terminal output omitted]\r\n" : "") + this.chunks.map(chunk => chunk.text).join("");
    }
}
