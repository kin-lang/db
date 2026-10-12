import type { AggregateFn, AggregateRef, ColumnRef, OrderKey, SelectItem, Statement, TableRef } from './ast';
import { KinDbError } from '../errors';
import { tokenize, type Token, type TokenType } from '../lexer/lexer';
import { KEYWORDS } from '../lexer/tokens';
import { columnTypeFromName, type ColumnDef } from '../pager/record';
import type { SqlParams } from '../sql';
import { assertJson, assertLimit, type JsonValue, type Predicate, type Row } from '../value';

const AGGREGATES: Record<string, AggregateFn> = {
  bara: 'count',
  teranya: 'sum',
  nto: 'min',
  nini: 'max',
};

export function parse(source: string, params?: SqlParams): Statement[] {
  return new Parser(tokenize(source), params).parseProgram();
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly params?: SqlParams,
  ) {}

  parseProgram(): Statement[] {
    const statements: Statement[] = [];
    while (!this.check('eof')) {
      this.skipSemis();
      if (this.check('eof')) break;
      statements.push(this.statement());
      if (!this.check('eof') && !this.check('semi') && this.startsStatement(this.peek().type)) {
        continue;
      }
      if (!this.check('eof')) this.expect('semi', true);
      this.skipSemis();
    }
    return statements;
  }

  private statement(): Statement {
    const token = this.peek();
    switch (token.type) {
      case 'kora':
        return this.createStatement();
      case 'siba':
        return this.deleteOrDrop();
      case 'shira':
        return this.insertStatement();
      case 'hindura':
        return this.updateStatement();
      case 'hitamo':
        return this.selectStatement();
      default:
        throw this.syntax(
          `Expected HITAMO, SHIRA, HINDURA, SIBA, or KORA, but found '${token.lexeme || token.type}'. Example: hitamo * muri abanyeshuri imipaka 10`,
          false,
        );
    }
  }

  private createStatement(): Statement {
    this.expect('kora');
    if (this.matchWord('urutonde')) return this.createIndex();
    this.expect('itsinda');
    const name = this.identifier();
    if (!this.match('lparen')) return { kind: 'create', name };
    const columns: ColumnDef[] = [];
    if (!this.check('rparen')) {
      columns.push(this.columnDef());
      while (this.match('comma')) columns.push(this.columnDef());
    }
    this.expect('rparen');
    return { kind: 'create', name, columns };
  }

  private createIndex(): Statement {
    const name = this.identifier();
    this.expect('muri');
    const collection = this.identifier();
    this.expect('lparen');
    const column = this.identifier();
    if (this.check('comma')) {
      throw this.syntax('An index covers one column', false);
    }
    this.expect('rparen');
    return { kind: 'createIndex', name, collection, column };
  }

  private deleteOrDrop(): Statement {
    this.expect('siba');
    if (this.match('byose')) return { kind: 'dropAll' };
    if (this.match('itsinda')) return { kind: 'drop', name: this.identifier() };
    if (this.matchWord('urutonde')) return { kind: 'dropIndex', name: this.identifier() };
    this.expect('muri');
    const collection = this.identifier();
    if (!this.match('aho')) {
      throw this.syntax(
        `SIBA needs AHO, or it would delete every row. Example: siba muri ${collection} aho id = 1`,
        this.peek().type === 'eof',
      );
    }
    return { kind: 'delete', collection, where: this.condition() };
  }

  private insertStatement(): Statement {
    this.expect('shira');
    this.expect('muri');
    const collection = this.identifier();
    if (this.check('lbrace')) {
      return { kind: 'insert', collection, row: this.objectRow() };
    }
    this.expect('lparen');
    const columns = this.identifierList();
    this.expect('rparen');
    this.expect('agaciro');
    this.expect('lparen');
    const values: JsonValue[] = [];
    if (!this.check('rparen')) {
      values.push(this.value());
      while (this.match('comma')) values.push(this.value());
    }
    this.expect('rparen');
    if (columns.length !== values.length) {
      throw this.syntax(
        `SHIRA lists ${columns.length} columns but ${values.length} values`,
        false,
      );
    }
    const row: Row = {};
    columns.forEach((column, index) => {
      if (column in row) {
        throw this.syntax(`Duplicate column '${column}'`, false);
      }
      row[column] = values[index];
    });
    return { kind: 'insert', collection, row };
  }

  private updateStatement(): Statement {
    this.expect('hindura');
    const collection = this.identifier();
    this.expect('shyira');
    const data: Row = {};
    this.assignment(data);
    while (this.match('comma')) this.assignment(data);
    if (!this.check('aho')) {
      throw this.syntax(
        'HINDURA needs AHO, or it would change every row. Example: hindura t shyira izina = "Aline" aho id = 1',
        this.peek().type === 'eof',
      );
    }
    this.expect('aho');
    return { kind: 'update', collection, data, where: this.condition() };
  }

  private selectStatement(): Statement {
    this.expect('hitamo');
    const columns = this.selectColumns();
    this.expect('muri');
    const from = [this.tableRef()];
    while (this.match('huza')) from.push(this.tableRef());
    const where = this.match('aho') ? this.condition() : [];
    const group = this.matchWord('koranya') ? this.columnList() : undefined;
    const order = this.matchWord('tondeka') ? this.orderList() : undefined;
    let limit: number | undefined;
    if (this.match('imipaka')) {
      if (this.check('minus')) {
        const number = this.tokens[this.index + 1];
        // `-0` is a limit of zero. Any other minus is not a whole number.
        if (number?.type === 'number' && number.value === 0) {
          this.advance();
          this.advance();
          limit = 0;
        } else {
          throw this.syntax('Limit must be a whole number, 0 or more. Example: imipaka 10', false);
        }
      } else if (!this.check('number')) {
        throw this.syntax(
          'Limit must be a whole number, 0 or more. Example: imipaka 10',
          this.peek().type === 'eof',
        );
      } else {
        const token = this.expect('number');
        const value = token.value;
        if (typeof value !== 'number') {
          throw this.syntax('Limit must be a whole number, 0 or more. Example: imipaka 10', false);
        }
        try {
          assertLimit(value);
        } catch (error) {
          if (error instanceof KinDbError) throw this.syntax(error.message, false);
          throw error;
        }
        limit = value;
      }
    }
    if (this.pendingClause()) {
      throw this.syntax(
        `Write AHO, then KORANYA, then TONDEKA, then IMIPAKA. '${this.peek().lexeme}' is out of order. Example: hitamo * muri abanyeshuri tondeka amanota manuka imipaka 10`,
        false,
      );
    }
    return { kind: 'select', columns, from, where, group, order, limit };
  }

  private pendingClause(): boolean {
    const token = this.peek();
    if (token.type === 'imipaka') return true;
    return token.type === 'identifier' && ['koranya', 'tondeka'].includes(token.lexeme.toLowerCase());
  }

  private selectColumns(): '*' | SelectItem[] {
    if (this.match('star')) return '*';
    const columns = [this.selectItem()];
    while (this.match('comma')) columns.push(this.selectItem());
    return columns;
  }

  private selectItem(): SelectItem {
    if (this.isAggregateCall()) return this.aggregate();
    return this.columnRef();
  }

  private columnList(): ColumnRef[] {
    const columns = [this.columnRef()];
    while (this.match('comma')) columns.push(this.columnRef());
    return columns;
  }

  private orderList(): OrderKey[] {
    const keys = [this.orderKey()];
    while (this.match('comma')) keys.push(this.orderKey());
    return keys;
  }

  private orderKey(): OrderKey {
    const item = this.isAggregateCall() ? this.aggregate() : this.columnRef();
    let direction: 'asc' | 'desc' = 'asc';
    if (this.matchWord('manuka')) direction = 'desc';
    else if (this.matchWord('zamuka')) direction = 'asc';
    return { item, direction };
  }

  private isAggregateCall(): boolean {
    const token = this.peek();
    if (token.type !== 'identifier') return false;
    const name = token.lexeme.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(AGGREGATES, name)) return false;
    return this.tokens[this.index + 1]?.type === 'lparen';
  }

  private aggregate(): AggregateRef {
    const token = this.identifier();
    const fn = AGGREGATES[token.toLowerCase()];
    if (!fn) {
      throw this.syntax(`Expected BARA, TERANYA, NTO, or NINI, but found '${token}'`, false);
    }
    this.expect('lparen');
    let column: '*' | ColumnRef;
    if (this.match('star')) {
      if (fn !== 'count') {
        throw this.syntax(`${token.toUpperCase()} needs a column. BARA(*) counts rows.`, false);
      }
      column = '*';
    } else {
      column = this.columnRef();
    }
    this.expect('rparen');
    return { kind: 'aggregate', fn, column };
  }

  private tableRef(): TableRef {
    const name = this.identifier();
    if (!this.check('identifier')) return { name };
    const next = this.peek().lexeme.toLowerCase();
    // KORANYA and TONDEKA introduce clauses. They are not reserved, so a
    // column can still use those names. Here they start the clause.
    if (next === 'koranya' || next === 'tondeka') return { name };
    return { name, alias: this.identifier() };
  }

  private columnRef(): ColumnRef {
    const first = this.identifier();
    if (!this.match('dot')) return { name: first };
    return { qualifier: first, name: this.identifier() };
  }

  private columnDef(): ColumnDef {
    const name = this.identifier();
    const next = this.peek();
    if (next.type === 'rparen' || next.type === 'comma' || next.type === 'eof') {
      throw this.syntax(
        `Column '${name}' needs a type: umubare, ijambo, ukuri, or ikintu. Example: kora itsinda t (id umubare)`,
        next.type === 'eof',
      );
    }
    const typeName = this.identifier();
    return { name, type: columnTypeFromName(typeName.toLowerCase()) };
  }

  private assignment(data: Row): void {
    const field = this.identifier();
    if (this.check('eqeq')) {
      throw this.syntax("SHYIRA uses '=' between a field and its value", false);
    }
    this.expect('eq');
    if (field in data) throw this.syntax(`Duplicate field '${field}'`, false);
    data[field] = this.value();
  }

  private condition(): Predicate[] {
    const predicates = [this.comparison()];
    while (this.match('kandi')) predicates.push(this.comparison());
    const next = this.peek();
    if (
      next.type === 'identifier' &&
      (next.lexeme.toLowerCase() === 'cyangwa' || next.lexeme.toLowerCase() === 'or')
    ) {
      throw this.syntax(
        'KinDB combines conditions with KANDI. There is no OR. Example: aho id = 1 kandi yize = nibyo',
        false,
      );
    }
    return predicates;
  }

  private comparison(): Predicate {
    if (this.peek().type === 'eof') {
      throw this.syntax('AHO needs a comparison. Example: aho id = 1', true);
    }
    const left = this.columnRef();
    const operator = this.peek();
    if (operator.type === 'lt' && this.tokens[this.index + 1]?.type === 'gt') {
      throw this.syntax(
        "KinDB has no '<>'. Compare with =, <, >, <=, >=, or ni. Example: aho id = 1",
        false,
      );
    }
    const finish = (op: Predicate['op'], numeric: boolean): Predicate => {
      this.advance();
      if (this.check('identifier')) {
        const right = this.columnRef();
        return {
          op,
          field: left.name,
          qualifier: left.qualifier,
          rightField: right.name,
          rightQualifier: right.qualifier,
        };
      }
      const value = this.value();
      if (numeric && typeof value !== 'number') {
        throw this.syntax(`Comparison '${operator.lexeme}' expects a number`, false);
      }
      return { op, field: left.name, qualifier: left.qualifier, value };
    };
    switch (operator.type) {
      case 'eq':
      case 'eqeq':
        return finish('loose', false);
      case 'lt':
      case 'munsi':
        return finish('lt', true);
      case 'lte':
      case 'munsi_cyangwa':
        return finish('lte', true);
      case 'gt':
      case 'hejuru':
        return finish('gt', true);
      case 'gte':
      case 'hejuru_cyangwa':
        return finish('gte', true);
      case 'ni':
        return finish('eq', true);
      default:
        throw this.syntax(
          `Expected =, <, >, <=, >=, or ni after '${this.formatColumn(left)}'. Example: aho id = 1`,
          operator.type === 'eof',
        );
    }
  }

  private formatColumn(column: ColumnRef): string {
    return column.qualifier ? `${column.qualifier}.${column.name}` : column.name;
  }

  private objectRow(): Row {
    this.expect('lbrace');
    const row: Row = {};
    if (this.match('rbrace')) return row;
    this.objectField(row);
    while (this.match('comma')) {
      if (this.check('rbrace')) break;
      this.objectField(row);
    }
    this.expect('rbrace');
    return row;
  }

  private objectField(row: Row): void {
    const keyToken = this.peek();
    let key: string;
    if (keyToken.type === 'string' && typeof keyToken.value === 'string') {
      this.advance();
      key = keyToken.value;
    } else {
      key = this.identifier();
    }
    this.expect('colon');
    if (key in row) throw this.syntax(`Duplicate field '${key}'`, false);
    row[key] = this.value();
  }

  private identifierList(): string[] {
    const names = [this.identifier()];
    while (this.match('comma')) names.push(this.identifier());
    return names;
  }

  private identifier(): string {
    const token = this.peek();
    if (token.type !== 'identifier') {
      const word = token.lexeme.toLowerCase();
      if (word && KEYWORDS[word]) {
        throw this.syntax(
          `'${token.lexeme}' is a KinDB word, so it cannot be a name. Choose another name, for example ${token.lexeme}_1.`,
          false,
        );
      }
      throw this.syntax(
        `Expected a name but found '${token.lexeme || token.type}'`,
        token.type === 'eof',
      );
    }
    this.advance();
    return token.lexeme;
  }

  private value(): JsonValue {
    if (this.match('minus')) {
      if (this.check('minus')) {
        throw this.syntax('A number has one minus. Example: -1', false);
      }
      const token = this.expect('number');
      return -(token.value as number);
    }
    const token = this.peek();
    if (token.type === 'number' && typeof token.value === 'number') {
      this.advance();
      return token.value;
    }
    if (token.type === 'string' && typeof token.value === 'string') {
      this.advance();
      return token.value;
    }
    if (token.type === 'param') {
      this.advance();
      const name = token.lexeme;
      if (!this.params || !Object.prototype.hasOwnProperty.call(this.params, name)) {
        throw this.syntax(
          `Unknown value $${name}. Pass it beside the script: query(sql, { ${name}: ... })`,
          false,
        );
      }
      const value: unknown = this.params[name];
      assertJson(value, `$${name}`);
      return value;
    }
    if (this.match('nibyo')) return true;
    if (this.match('sibyo')) return false;
    if (this.match('ubusa')) return null;
    throw this.syntax(`Expected a value but found '${token.lexeme || token.type}'`, token.type === 'eof');
  }

  private skipSemis(): void {
    while (this.match('semi')) {
      /* statement separators are optional between keywords too */
    }
  }

  private startsStatement(type: TokenType): boolean {
    return type === 'kora' || type === 'siba' || type === 'shira' || type === 'hindura' || type === 'hitamo';
  }

  /** `urutonde` is not reserved, so a column may still use that name. */
  private matchWord(word: string): boolean {
    const token = this.peek();
    if (token.type !== 'identifier' || token.lexeme.toLowerCase() !== word) return false;
    this.advance();
    return true;
  }

  private match(type: TokenType): boolean {
    if (!this.check(type)) return false;
    this.advance();
    return true;
  }

  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private advance(): Token {
    const token = this.peek();
    if (token.type !== 'eof') this.index += 1;
    return token;
  }

  private peek(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1];
  }

  private expect(type: TokenType, optionalAtEof = false): Token {
    const token = this.peek();
    if (token.type === type) return this.advance();
    const incomplete = token.type === 'eof';
    if (optionalAtEof && incomplete) return token;
    throw this.syntax(
      `Expected '${type}' but found '${token.lexeme || token.type}'`,
      incomplete,
    );
  }

  private syntax(message: string, incomplete: boolean): KinDbError {
    const token = this.peek();
    return new KinDbError('E_SYNTAX', `${message} at ${token.line}:${token.column}`, incomplete);
  }
}
