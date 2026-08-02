export type ScrollAnchor = {
	source: number
	top: number
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), maximum)
}

export function normalizeScrollAnchors(
	anchors: ScrollAnchor[],
	documentLength: number,
	maximumScrollTop: number,
): ScrollAnchor[] {
	const maxSource = Math.max(0, documentLength)
	const maxTop = Math.max(0, maximumScrollTop)
	const points = [
		{ source: 0, top: 0 },
		...anchors.filter(
			(anchor) => Number.isFinite(anchor.source) && Number.isFinite(anchor.top),
		),
		{ source: maxSource, top: maxTop },
	]
		.map((anchor) => ({
			source: clamp(anchor.source, 0, maxSource),
			top: clamp(anchor.top, 0, maxTop),
		}))
		.sort((left, right) => left.source - right.source || left.top - right.top)

	const grouped: ScrollAnchor[] = []
	for (const point of points) {
		const previous = grouped[grouped.length - 1]
		if (previous?.source === point.source) {
			if (point.source === 0) previous.top = Math.min(previous.top, point.top)
			else if (point.source === maxSource) {
				previous.top = Math.max(previous.top, point.top)
			} else {
				previous.top = (previous.top + point.top) / 2
			}
		} else {
			grouped.push({ ...point })
		}
	}

	let previousTop = 0
	for (const point of grouped) {
		point.top = Math.max(previousTop, point.top)
		previousTop = point.top
	}
	return grouped
}

export function sourcePositionToScrollTop(
	position: number,
	anchors: ScrollAnchor[],
): number {
	if (anchors.length === 0) return 0
	const target = clamp(position, anchors[0].source, anchors.at(-1)!.source)
	if (target <= anchors[0].source) return anchors[0].top
	if (target >= anchors.at(-1)!.source) return anchors.at(-1)!.top

	for (let index = 1; index < anchors.length; index += 1) {
		const after = anchors[index]
		if (target > after.source) continue
		const before = anchors[index - 1]
		const sourceDistance = after.source - before.source
		if (sourceDistance <= 0) return after.top
		const ratio = (target - before.source) / sourceDistance
		return before.top + (after.top - before.top) * ratio
	}
	return anchors.at(-1)!.top
}

export function scrollTopToSourcePosition(
	scrollTop: number,
	anchors: ScrollAnchor[],
): number {
	if (anchors.length === 0) return 0
	const target = clamp(scrollTop, anchors[0].top, anchors.at(-1)!.top)
	if (target <= anchors[0].top) return anchors[0].source
	if (target >= anchors.at(-1)!.top) return anchors.at(-1)!.source

	for (let index = 1; index < anchors.length; index += 1) {
		const after = anchors[index]
		if (target > after.top) continue
		const before = anchors[index - 1]
		const topDistance = after.top - before.top
		if (topDistance <= 0) return after.source
		const ratio = (target - before.top) / topDistance
		return Math.round(
			before.source + (after.source - before.source) * ratio,
		)
	}
	return anchors.at(-1)!.source
}
