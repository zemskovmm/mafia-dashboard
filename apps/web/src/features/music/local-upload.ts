export const uploadSequentially = async <Input, Output>(
  inputs: readonly Input[],
  upload: (input: Input) => Promise<Output>,
  onUploaded: (output: Output) => void = () => undefined,
): Promise<readonly Output[]> => {
  const uploaded: Output[] = [];
  for (const input of inputs) {
    const output = await upload(input);
    uploaded.push(output);
    onUploaded(output);
  }
  return uploaded;
};

export const mergeByStableId = <Value extends { readonly id: string }>(
  existing: readonly Value[],
  incoming: readonly Value[],
): readonly Value[] => {
  const merged = new Map(existing.map((value) => [value.id, value] as const));
  for (const value of incoming) merged.set(value.id, value);
  return [...merged.values()];
};
