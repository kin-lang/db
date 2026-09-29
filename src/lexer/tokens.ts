export type TokenType =
  | 'identifier'
  | 'string'
  | 'number'
  | 'star'
  | 'comma'
  | 'lbrace'
  | 'rbrace'
  | 'lparen'
  | 'rparen'
  | 'colon'
  | 'dot'
  | 'eq'
  | 'eqeq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'minus'
  | 'semi'
  | 'kora'
  | 'itsinda'
  | 'siba'
  | 'byose'
  | 'shira'
  | 'muri'
  | 'agaciro'
  | 'hindura'
  | 'shyira'
  | 'aho'
  | 'hitamo'
  | 'huza'
  | 'imipaka'
  | 'kandi'
  | 'ni'
  | 'munsi'
  | 'munsi_cyangwa'
  | 'hejuru'
  | 'hejuru_cyangwa'
  | 'nibyo'
  | 'sibyo'
  | 'ubusa'
  | 'eof';

export interface Token {
  type: TokenType;
  lexeme: string;
  value?: string | number;
  line: number;
  column: number;
}

export const KEYWORDS: Record<string, TokenType> = {
  kora: 'kora',
  itsinda: 'itsinda',
  siba: 'siba',
  byose: 'byose',
  shira: 'shira',
  muri: 'muri',
  agaciro: 'agaciro',
  hindura: 'hindura',
  shyira: 'shyira',
  aho: 'aho',
  hitamo: 'hitamo',
  huza: 'huza',
  imipaka: 'imipaka',
  kandi: 'kandi',
  ni: 'ni',
  munsi: 'munsi',
  munsi_cyangwa: 'munsi_cyangwa',
  hejuru: 'hejuru',
  hejuru_cyangwa: 'hejuru_cyangwa',
  nibyo: 'nibyo',
  sibyo: 'sibyo',
  ubusa: 'ubusa',
};
