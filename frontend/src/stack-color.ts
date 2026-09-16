/** Stable letter colors identify stacks; they do not encode container health. */
export function stackColor(name : string) : string {
    const letter = name.trim().slice(0, 1).toUpperCase();
    const groups = [ "PABCDE", "IFGHK", "ULMNO", "VRSTW", "JQXYZ0123456789" ];
    const colors = [ "green", "purple", "blue", "teal", "gray" ];
    const index = groups.findIndex(group => group.includes(letter) && letter !== "");
    return colors[index] ?? colors[(letter.codePointAt(0) ?? 0) % colors.length] ?? "gray";
}
