/**
 * How the page names a file in a sentence ("Typed in ci.yml", "the plan waits for valid YAML: setup/action.yml line
 * 3"): its name, and for an action its directory too, since every action file is called `action.yml`.
 */
export function fileLabel(path: string): string {
  const parts = path.split('/');
  const name = parts.at(-1) ?? path;
  return /^action\.ya?ml$/i.test(name) && parts.length > 1 ? `${parts.at(-2)}/${name}` : name;
}
