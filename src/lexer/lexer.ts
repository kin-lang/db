import { KinDbError } from '../errors';
import { isDigit, isIdentPart, isIdentStart } from './chars';
import { KEYWORDS, type Token, type TokenType } from './tokens';

const SYMBOLS: Record<string, TokenType> = {
  '==': 'eqeq',
  '<=': 'lte',
  '>=': 'gte',
  '*': 'star',
  ',': 'comma',
  '{': 'lbrace',
  '}': 'rbrace',
  '(': 'lparen',
  ')': 'rparen',
  ':': 'colon',
  '.': 'dot',
  '=': 'eq',
  '<': 'lt',
  '>': 'gt',
  '-': 'minus',
  ';': 'semi',
};

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '\\': '\\',
  '"': '"',
  "'": "'",
};

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let column = 1;

  const peek = (offset = 0) => source[index + offset] ?? '';
  const advance = () => {
    const char = source[index] ?? '';
    index += 1;
    if (char === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    return char;
  };

  while (index < source.length) {
    const char = peek();
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      advance();
      continue;
    }
    if (char === '#' || (char === '-' && peek(1) === '-')) {
      while (index < source.length && peek() !== '\n') advance();
      continue;
    }

    const startLine = line;
    const startColumn = column;
    if (char === '"' || char === "'") {
      tokens.push(scanString(char, startLine, startColumn));
      continue;
    }
    if (isDigit(char)) {
      tokens.push(scanNumber(startLine, startColumn));
      continue;
    }
    if (isIdentStart(char)) {
      tokens.push(scanIdentifier(startLine, startColumn));
      continue;
    }

    const two = char + peek(1);
    const type = SYMBOLS[two] ?? SYMBOLS[char];
    if (!type) {
      throw new KinDbError(
        'E_SYNTAX',
        `Unexpected character '${char}' at ${startLine}:${startColumn}`,
      );
    }
    const lexeme = SYMBOLS[two] ? two : char;
    advance();
    if (lexeme.length === 2) advance();
    tokens.push({ type, lexeme, line: startLine, column: startColumn });
  }

  tokens.push({ type: 'eof', lexeme: '', line, column });
  return tokens;

  function scanString(quote: string, startLine: number, startColumn: number): Token {
    advance();
    let value = '';
    while (index < source.length && peek() !== quote) {
      const current = advance();
      if (current === '\n') {
        throw new KinDbError('E_SYNTAX', `Unterminated string at ${startLine}:${startColumn}`);
      }
      if (current !== '\\') {
        value += current;
        continue;
      }
      const escaped = advance();
      if (!(escaped in ESCAPES)) {
        throw new KinDbError(
          'E_SYNTAX',
          `Unknown string escape '\\${escaped}' at ${line}:${column}`,
        );
      }
      value += ESCAPES[escaped];
    }
    if (peek() !== quote) {
      throw new KinDbError('E_SYNTAX', `Unterminated string at ${startLine}:${startColumn}`);
    }
    advance();
    return { type: 'string', lexeme: value, value, line: startLine, column: startColumn };
  }

  function scanNumber(startLine: number, startColumn: number): Token {
    const start = index;
    while (isDigit(peek())) advance();
    if (peek() === '.' && isDigit(peek(1))) {
      advance();
      while (isDigit(peek())) advance();
    }
    const lexeme = source.slice(start, index);
    return {
      type: 'number',
      lexeme,
      value: Number(lexeme),
      line: startLine,
      column: startColumn,
    };
  }

  function scanIdentifier(startLine: number, startColumn: number): Token {
    const start = index;
    while (isIdentPart(peek())) advance();
    const lexeme = source.slice(start, index);
    const keyword = KEYWORDS[lexeme.toLowerCase()];
    if (keyword) {
      return { type: keyword, lexeme, line: startLine, column: startColumn };
    }
    return { type: 'identifier', lexeme, line: startLine, column: startColumn };
  }
}

export type { Token, TokenType };
