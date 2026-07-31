export const MAX_MARKDOWN_BYTES = 2_000_000
export const MAX_YJS_SNAPSHOT_BYTES = 8 * 1024 * 1024
export const MAX_WEBSOCKET_MESSAGE_BYTES = 8 * 1024 * 1024
export const MAX_AWARENESS_MESSAGE_BYTES = 64 * 1024

export const MAX_JSON_BODY_BYTES = 32 * 1024
export const MAX_IMAGE_UPLOAD_BODY_BYTES = 11 * 1024 * 1024
export const MAX_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024

export function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength
}

export function exceedsUtf8ByteLimit(value: string, maxBytes: number): boolean {
	if (value.length > maxBytes) return true
	if (value.length <= Math.floor(maxBytes / 3)) return false
	return utf8ByteLength(value) > maxBytes
}
