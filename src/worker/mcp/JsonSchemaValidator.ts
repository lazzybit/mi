// Interprets JSON Schema without dynamic code generation (PLAN.md -> Tool
// dispatch boundary). `@cfworker/json-schema` is a pure interpreter, so it is
// safe under the Workers runtime's prohibition on `new Function`.

import { Validator } from "@cfworker/json-schema";
import { AppError } from "../../shared/domain";
import type { JsonSchema } from "./types";

export class JsonSchemaValidator {
  validate(schema: JsonSchema, value: unknown): void {
    if (schema === true) return;
    if (schema === false) throw new AppError("INVALID_INPUT", "tool does not accept arguments");
    const validator = new Validator(schema as Record<string, unknown>, "2019-09", false);
    const result = validator.validate(value);
    if (!result.valid) {
      const detail = result.errors
        .slice(0, 3)
        .map((error) => `${error.instanceLocation || "/"} ${error.error}`)
        .join("; ");
      throw new AppError("INVALID_INPUT", `tool arguments failed validation: ${detail}`);
    }
  }
}
