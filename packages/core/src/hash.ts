export const hash = (input: string) => Bun.hash(input).toString(16).padStart(16, "0");
