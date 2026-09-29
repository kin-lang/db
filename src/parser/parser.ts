import type { ColumnRef, Statement, TableRef } from './ast';
import { KinDbError } from '../errors';
import { tokenize, type Token, type TokenType } from '../lexer/lexer';
import { columnTypeFromName, type ColumnDef } from '../pager/record';
import type { JsonValue, Predicate, Row } from '../value';

export function parse(source: string): Statement[] {
  return new Parser(tokenize(source)).parseProgram();
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

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
        throw this.syntax(`Expected a statement but found '${token.lexeme || token.type}'`, false);
    }
  }

  private createStatement(): Statement {
    this.expect('kora');
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

  private deleteOrDrop(): Statement {
    this.expect('siba');
    if (this.match('byose')) return { kind: 'dropAll' };
    if (this.match('itsinda')) return { kind: 'drop', name: this.identifier() };
    this.expect('muri');
    const collection = this.identifier();
    this.expect('aho');
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
    let limit: number | undefined;
    if (this.match('imipaka')) {
      const token = this.expect('number');
      const value = token.value;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw this.syntax('IMIPAKA expects a non-negative integer', false);
      }
      limit = value;
    }
    return { kind: 'select', columns, from, where, limit };
  }

  private selectColumns(): '*' | ColumnRef[] {
    if (this.match('star')) return '*';
    const columns = [this.columnRef()];
    while (this.match('comma')) columns.push(this.columnRef());
    return columns;
  }

  private tableRef(): TableRef {
    const name = this.identifier();
    if (!this.check('identifier')) return { name };
    return { name, alias: this.identifier() };
  }

  private columnRef(): ColumnRef {
    const first = this.identifier();
    if (!this.match('dot')) return { name: first };
    return { qualifier: first, name: this.identifier() };
  }

  private columnDef(): ColumnDef {
    const name = this.identifier();
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
    return predicates;
  }

  private comparison(): Predicate {
    const left = this.columnRef();
    const operator = this.peek();
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
          `Expected a comparison after '${this.formatColumn(left)}'`,
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
