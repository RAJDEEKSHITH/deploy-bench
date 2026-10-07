import { parseDocument } from "yaml"; // npm i yaml  (v2)

const MAX_ALIAS_COUNT = 50; // protects against "billion laughs" alias expansion
const MAX_ERROR_LENGTH = 2_000;

export class PipelineParseError extends Error {
  constructor(message: string) {
    super(message.slice(0, MAX_ERROR_LENGTH));
    this.name = "PipelineParseError";
  }
}

/**
 * Raw YAML -> plain JavaScript value.
 *
 * Throws PipelineParseError for anything that is not valid YAML:
 * syntax errors, duplicate keys, multiple documents, excessive aliases.
 */
export const parsePipelineYaml = (rawYaml: string): unknown => {
  // uniqueKeys is on by default; explicit so a duplicated job key is an error
  // instead of silently overwriting the first definition.
  const document = parseDocument(rawYaml, { uniqueKeys: true });

  const [firstError] = document.errors;
  if (firstError) throw new PipelineParseError(firstError.message);

  try {
    return document.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (error) {
    throw new PipelineParseError(error instanceof Error ? error.message : "Invalid YAML");
  }
};