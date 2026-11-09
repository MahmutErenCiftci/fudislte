/** Folds text for case-insensitive search with Turkish casing rules (İ → i, I → ı). */
export const searchKey = (s: string) => s.toLocaleLowerCase('tr')
