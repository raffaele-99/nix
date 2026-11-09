// Pi aliases the pi-ai package root to compat.js when loading extensions, which
// breaks its API subpaths. Resolve native modules from the running pi CLI instead.
import { createRequire, findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const piRequire = createRequire(process.argv[1]);
const aiPackage = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(process.argv[1]));
if (!aiPackage) throw new Error("pi-ai is not installed beside the pi runtime");
const aiRoot = dirname(aiPackage);

export function piAIRequire(path: string): unknown {
	return piRequire(join(aiRoot, "dist", `${path}.js`));
}

export function piCodingRequire(path: string): unknown {
	const packageFile = findPackageJSON("@earendil-works/pi-coding-agent", pathToFileURL(process.argv[1]));
	if (!packageFile) throw new Error("pi-coding-agent is not installed beside the runtime");
	return piRequire(join(dirname(packageFile), "dist", `${path}.js`));
}
