import type { output, ZodType } from 'zod';

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult<Value> {
  readonly success: boolean;
  readonly data?: Value;
  readonly issues: readonly ValidationIssue[];
}

export function validateWithSchema<Schema extends ZodType>(
  schema: Schema,
  input: unknown,
): ValidationResult<output<Schema>> {
  const result = schema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data, issues: [] };
  }

  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}
