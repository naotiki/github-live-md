export type EditorColorScheme =
	| 'midnight'
	| 'github-dark'
	| 'paper'
	| 'solarized'

export const EDITOR_COLOR_SCHEMES: {
	value: EditorColorScheme
	label: string
}[] = [
	{ value: 'midnight', label: 'Midnight green' },
	{ value: 'github-dark', label: 'GitHub dark' },
	{ value: 'paper', label: 'Paper light' },
	{ value: 'solarized', label: 'Solarized dark' },
]
