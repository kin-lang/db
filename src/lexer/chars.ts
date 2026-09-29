export function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

export function isIdentStart(char: string): boolean {
  return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '_';
}

export function isIdentPart(char: string): boolean {
  return isIdentStart(char) || isDigit(char);
}
