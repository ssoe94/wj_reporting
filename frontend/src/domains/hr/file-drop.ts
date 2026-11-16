export function isHrFileDrag(data: Pick<DataTransfer, 'types' | 'files'> | null): boolean {
  return Boolean(data && (Array.from(data.types).includes('Files') || data.files.length > 0));
}

type FileCandidate = { name?: string; kind?: string } | null | undefined;
type FilePolicy = { extensions: readonly string[]; maxFiles: number; existingFiles?: number; disabled?: boolean };

function isNamedFile<T extends FileCandidate>(candidate: T): candidate is T & { name: string } {
  return Boolean(candidate && (candidate.kind == null || candidate.kind === 'file') &&
    typeof candidate.name === 'string' && candidate.name.length > 0);
}

export function filterHrFiles<T extends FileCandidate>(candidates: ArrayLike<T>, policy: FilePolicy) {
  const files = Array.from(candidates).filter(isNamedFile);
  if (!files.length) return { status: 'ignored' } as const;
  if (policy.disabled) return { status: 'disabled' } as const;
  if (files.length + (policy.existingFiles ?? 0) > policy.maxFiles) return { status: 'count' } as const;
  if (files.some(file => !policy.extensions.some(extension => file.name.toLowerCase().endsWith(extension)))) {
    return { status: 'extension' } as const;
  }
  return { status: 'accepted', files } as const;
}
