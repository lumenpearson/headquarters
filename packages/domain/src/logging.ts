export interface LogEvent {
  readonly at: number;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly scope: string;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface LoggerPort {
  debug(scope: string, message: string, data?: Readonly<Record<string, unknown>>): void;
  info(scope: string, message: string, data?: Readonly<Record<string, unknown>>): void;
  warn(scope: string, message: string, data?: Readonly<Record<string, unknown>>): void;
  error(scope: string, message: string, data?: Readonly<Record<string, unknown>>): void;
  read(): readonly LogEvent[];
}
