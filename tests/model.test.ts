import { describe, expect, it } from 'vitest';
import { joinPath, parentPath, visibleEntries, type FileEntry } from '../src/model';

function entry(name: string, isDirectory = false, size = 0): FileEntry {
  return { name, path: `/workspace/${name}`, isDirectory, size, modified: null };
}

describe('local and remote path navigation', () => {
  it.each([
    ['/', 'file.txt', '/file.txt'],
    ['/home/user/', 'file.txt', '/home/user/file.txt'],
    ['/home/user', 'folder', '/home/user/folder'],
    ['C:\\', 'file.txt', 'C:\\file.txt'],
    ['C:\\Users\\Alice\\', 'Documents', 'C:\\Users\\Alice\\Documents'],
    ['C:/', 'file.txt', 'C:/file.txt'],
    ['D:/Work/', 'folder', 'D:/Work/folder'],
  ])('joins %s and %s', (parent, name, expected) => {
    expect(joinPath(parent, name)).toBe(expected);
  });

  it.each([
    ['/', '/'],
    ['/home', '/'],
    ['/home/user/', '/home'],
    ['/home/user/file.txt', '/home/user'],
    ['C:\\', 'C:\\'],
    ['D:/', 'D:/'],
    ['C:', 'C:'],
    ['C:\\Users', 'C:\\'],
    ['C:\\Users\\Alice\\', 'C:\\Users'],
    ['D:/Work', 'D:/'],
    ['D:/Work/project/', 'D:/Work'],
  ])('finds parent of %s without escaping its root', (path, expected) => {
    expect(parentPath(path)).toBe(expected);
  });
});

describe('directory views', () => {
  const entries = [
    entry('zebra.txt', false, 500),
    entry('assets', true),
    entry('.env', false, 10),
    entry('Alpha.txt', false, 100),
    entry('.git', true),
    entry('docs', true),
  ];

  it('hides dotfiles and dot-directories unless explicitly enabled', () => {
    expect(visibleEntries(entries, '', false, 'name').map((e) => e.name)).toEqual([
      'assets',
      'docs',
      'Alpha.txt',
      'zebra.txt',
    ]);
    expect(visibleEntries(entries, '', true, 'name')).toHaveLength(entries.length);
    expect(visibleEntries(entries, '.env', false, 'name')).toEqual([]);
  });

  it('filters case-insensitively while honoring hidden-file visibility', () => {
    expect(visibleEntries(entries, 'ALPHA', false, 'name').map((e) => e.name)).toEqual([
      'Alpha.txt',
    ]);
    expect(visibleEntries(entries, '.GIT', true, 'name').map((e) => e.name)).toEqual(['.git']);
    expect(visibleEntries(entries, 'missing', true, 'name')).toEqual([]);
  });

  it('keeps directories first when sorting by descending size', () => {
    expect(visibleEntries(entries, '', false, 'size').map((e) => e.name)).toEqual([
      'assets',
      'docs',
      'zebra.txt',
      'Alpha.txt',
    ]);
  });

  it('uses names to break equal-size ties without mutating its input', () => {
    const unsorted = [entry('z.txt', false, 20), entry('a.txt', false, 20), entry('folder', true)];
    const before = [...unsorted];
    expect(visibleEntries(unsorted, '', true, 'size').map((e) => e.name)).toEqual([
      'folder',
      'a.txt',
      'z.txt',
    ]);
    expect(unsorted).toEqual(before);
  });

  it('handles an empty directory', () => {
    expect(visibleEntries([], '', false, 'name')).toEqual([]);
  });
});

describe('Windows canonical roots', () => {
  it('keeps a verbatim drive root intact', () => {
    expect(parentPath('\\\\?\\C:\\')).toBe('\\\\?\\C:\\');
    expect(parentPath('\\\\?\\C:\\Users')).toBe('\\\\?\\C:\\');
  });
  it('keeps UNC share roots intact', () => {
    expect(parentPath('\\\\server\\share')).toBe('\\\\server\\share');
    expect(parentPath('\\\\?\\UNC\\server\\share\\')).toBe('\\\\?\\UNC\\server\\share\\');
  });
});
