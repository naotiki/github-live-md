export class ApiError extends Error {
	readonly status: number
	readonly details?: unknown

	constructor(
		message: string,
		status: number,
		details?: unknown,
	) {
		super(message)
		this.status = status
		this.details = details
	}
}

function rejectDeclaredOversize(request: Request, maxBytes: number): void {
	const value = request.headers.get('Content-Length')
	if (!value || !/^\d+$/.test(value)) return
	if (Number(value) > maxBytes) {
		throw new ApiError(`Request body must not exceed ${maxBytes} bytes`, 413)
	}
}

export async function readRequestBody(
	request: Request,
	maxBytes: number,
): Promise<Uint8Array> {
	rejectDeclaredOversize(request, maxBytes)
	if (!request.body) return new Uint8Array()

	const reader = request.body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			total += value.byteLength
			if (total > maxBytes) {
				throw new ApiError(`Request body must not exceed ${maxBytes} bytes`, 413)
			}
			chunks.push(value)
		}
	} finally {
		reader.releaseLock()
	}

	const body = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		body.set(chunk, offset)
		offset += chunk.byteLength
	}
	return body
}

export async function readJsonBody<T>(
	request: Request,
	maxBytes: number,
): Promise<T> {
	const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim()
	if (contentType?.toLowerCase() !== 'application/json') {
		throw new ApiError('Content-Type must be application/json', 415)
	}
	const body = await readRequestBody(request, maxBytes)
	try {
		return JSON.parse(new TextDecoder().decode(body)) as T
	} catch {
		throw new ApiError('Invalid JSON body', 400)
	}
}

export async function readMultipartFormData(
	request: Request,
	maxBytes: number,
): Promise<FormData> {
	const contentType = request.headers.get('Content-Type')
	if (!contentType?.toLowerCase().startsWith('multipart/form-data;')) {
		throw new ApiError('Content-Type must be multipart/form-data', 415)
	}
	const body = await readRequestBody(request, maxBytes)
	const boundedRequest = new Request(request.url, {
		method: 'POST',
		headers: { 'Content-Type': contentType },
		body,
	})
	return boundedRequest.formData()
}
