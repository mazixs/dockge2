import pkg from "../package.json";
import fs from "fs";
import dayjs from "dayjs";

const oldVersion = pkg.version;
const newVersion = oldVersion + "-nightly-" + dayjs().format("YYYYMMDDHHmmss");

console.log("Old Version: " + oldVersion);
console.log("New Version: " + newVersion);

// Только манифест. README тоже переписывался заменой версии по всему тексту,
// а версия встречается в нем прозой ("it starts at 0.0.1") и в примере
// ветки release/2.0 - ночная сборка портила документацию
pkg.version = newVersion;
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 4) + "\n");
