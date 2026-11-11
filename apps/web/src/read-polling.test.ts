import { afterEach, describe, expect, it, vi } from 'vitest';
import { startReadPolling } from './read-polling.js';

afterEach(() => vi.useRealTimers());

describe('saved revision polling', () => {
  it('recovers when the first read fails, then follows the server interval and stop signal', async () => {
    vi.useFakeTimers();
    const read = vi
      .fn<() => Promise<number | null | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(25)
      .mockResolvedValueOnce(null);
    startReadPolling(read);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(24_999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('backs off bounded read failures and resets after recovery', async () => {
    vi.useFakeTimers();
    const read = vi
      .fn<() => Promise<number | null | undefined>>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(null);
    const stop = startReadPolling(read);
    for (const delay of [10, 10, 20, 40, 60, 10, 10]) {
      const before = read.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay * 1000 - 1);
      expect(read).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(before + 1);
    }
    stop();
  });

  it('does not overlap automatic reads when the connection is slow', async () => {
    vi.useFakeTimers();
    let finish!: (value: number | null) => void;
    const read = vi.fn(
      () => new Promise<number | null>((resolve) => (finish = resolve)),
    );
    const stop = startReadPolling(read);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(read).toHaveBeenCalledOnce();
    finish(10);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
    finish(null);
  });

  it('stops before the first read when the user leaves the revision', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => 10);
    startReadPolling(read)();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).not.toHaveBeenCalled();
  });

  it('cannot restart a stale revision after its pending read settles', async () => {
    vi.useFakeTimers();
    let finish!: (value: number) => void;
    const oldRead = vi.fn(
      () => new Promise<number>((resolve) => (finish = resolve)),
    );
    const stop = startReadPolling(oldRead);
    await vi.advanceTimersByTimeAsync(10_000);
    stop();
    const currentRead = vi.fn(async () => null);
    startReadPolling(currentRead);
    finish(10);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(oldRead).toHaveBeenCalledOnce();
    expect(currentRead).toHaveBeenCalledOnce();
  });
});
