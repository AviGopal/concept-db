/**
 * Structured logging utility
 * Supports both JSON and text formats based on configuration
 *
 * NOTE: Logger is designed to be independent of config to avoid circular dependencies.
 * It reads LOG_LEVEL and LOG_FORMAT directly from environment.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: unknown;
}

// Read directly from env to avoid circular dependency with config
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info') as LogLevel;
const LOG_FORMAT = (process.env.LOG_FORMAT || 'text') as 'json' | 'text';

class Logger {
  private formatJson(level: LogLevel, message: string, context?: LogContext): string {
    const log = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      service: 'concept-db',
      message,
      ...context,
    };
    return JSON.stringify(log);
  }

  private formatText(level: LogLevel, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    const levelStr = level.toUpperCase().padEnd(5);
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';
    return `${timestamp} ${levelStr} [concept-db] ${message}${contextStr}`;
  }

  private log(level: LogLevel, message: string, context?: LogContext): void {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const currentLevel = levels.indexOf(LOG_LEVEL);
    const messageLevel = levels.indexOf(level);

    if (messageLevel < currentLevel) {
      return;
    }

    const formatted = LOG_FORMAT === 'json'
      ? this.formatJson(level, message, context)
      : this.formatText(level, message, context);

    if (level === 'error') {
      console.error(formatted);
    } else if (level === 'warn') {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }
}

export const logger = new Logger();
