type ErrorMessage = string;
export type ActionResponse<T> = Promise<[T] | [undefined, ErrorMessage]>;

export interface EncoderStatusDTO {
  status: string;
  playlist?: string;
}

export async function getEncoderStatus(
  apiUrl: string
): ActionResponse<EncoderStatusDTO> {
  try {
    const url = new URL(`${apiUrl}/encoder`);
    const response = await fetch(url);
    if (!response.ok) {
      return [undefined, 'Failed to fetch encoder status'];
    }
    return [await response.json()];
  } catch (e) {
    return [undefined, 'Failed to fetch encoder status'];
  }
}

export async function startEncoder(apiUrl: string): ActionResponse<void> {
  try {
    const url = new URL(`${apiUrl}/encoder`);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ timeout: 0 })
    });
    if (!response.ok) {
      return [undefined, 'Failed to start encoder'];
    }
    return [undefined];
  } catch (e) {
    return [undefined, 'Failed to start encoder'];
  }
}

export async function stopEncoder(apiUrl: string): ActionResponse<void> {
  const url = new URL(`${apiUrl}/encoder`);
  const response = await fetch(url, {
    method: 'DELETE'
  });
  if (!response.ok) {
    return [undefined, 'Failed to stop encoder'];
  }
  return [undefined];
}
