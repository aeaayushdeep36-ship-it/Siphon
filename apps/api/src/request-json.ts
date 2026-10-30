import { type ZodType } from 'zod';
import { ApiError } from './errors.js';
import { readJsonBounded } from './http.js';

export async function parseRequestJson<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<T> {
  if (
    request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !==
    'application/json'
  )
    throw new ApiError(
      422,
      'invalid_content_type',
      'Expected application/json.',
    );
  let input: unknown;
  try {
    input = await readJsonBounded(new Response(request.body), 16 * 1024);
  } catch (error) {
    if (error instanceof Error && error.message === 'Body exceeds limit')
      throw new ApiError(
        413,
        'body_too_large',
        'Request body exceeds the limit.',
      );
    throw new ApiError(422, 'invalid_json', 'Provide a valid JSON request.');
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(
      422,
      'invalid_input',
      'Request does not match the supported contract.',
    );
  return parsed.data;
}
