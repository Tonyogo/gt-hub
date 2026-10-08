const { formatTemplate } = require('../scripts/gt.js');

describe('gt formatTemplate evaluator', () => {
  const sampleHosts = [
    { id: 'host-1111', name: 'prod-web', status: 'online', platform: 'linux', ip: '10.0.0.1', lastSeen: 1726830000000 },
    { id: 'host-2222', name: 'staging-db', status: 'offline', platform: 'darwin', ip: '10.0.0.2', lastSeen: null },
  ];

  it('evaluates raw property placeholders per line', () => {
    const output = formatTemplate('{{.ID}}: {{.Name}} ({{.Status}})', sampleHosts);
    const lines = output.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('host-1111: prod-web (online)');
    expect(lines[1]).toBe('host-2222: staging-db (offline)');
  });

  it('renders tabular table format with aligned columns and headers', () => {
    const output = formatTemplate('table {{.ID}}\t{{.Name}}\t{{.Status}}', sampleHosts);
    const lines = output.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^ID\s+NAME\s+STATUS$/);
    expect(lines[1]).toContain('host-1111');
    expect(lines[1]).toContain('prod-web');
    expect(lines[2]).toContain('host-2222');
  });

  it('handles empty datasets cleanly', () => {
    const output = formatTemplate('table {{.ID}}\t{{.Name}}', []);
    expect(output.trim()).toMatch(/^ID\s+NAME$/);
  });
});
