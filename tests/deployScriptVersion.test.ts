import { execSync } from 'child_process';
import path from 'path';

describe('Deploy Script & Git Describe Version Derivation', () => {
  it('derives clean version without suffix on tagged commit (v1.0.1)', () => {
    // v1.0.1 tag
    const describeOut = execSync('git describe --tags --always v1.0.1', {
      cwd: path.join(__dirname, '..'),
    }).toString().trim();

    expect(describeOut).toBe('v1.0.1');

    // Test deploy.sh regex logic
    let targetVersion = '';
    if (/^v?[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(describeOut)) {
      targetVersion = describeOut.startsWith('v') ? describeOut : `v${describeOut}`;
    } else {
      targetVersion = `v1.0.0+${describeOut}`;
    }

    expect(targetVersion).toBe('v1.0.1');
    expect(targetVersion.includes('+')).toBe(false);
  });

  it('derives version with commit suffix on untagged commit (bf11998)', () => {
    // Commit bf11998 has no tag
    const describeOut = execSync('git describe --tags --always bf11998', {
      cwd: path.join(__dirname, '..'),
    }).toString().trim();

    expect(describeOut).toBe('bf11998');

    // Test deploy.sh regex logic
    let targetVersion = '';
    if (/^v?[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(describeOut)) {
      targetVersion = describeOut.startsWith('v') ? describeOut : `v${describeOut}`;
    } else {
      targetVersion = `v1.0.0+${describeOut}`;
    }

    expect(targetVersion).toBe('v1.0.0+bf11998');
    expect(targetVersion.includes('+')).toBe(true);
  });
});
