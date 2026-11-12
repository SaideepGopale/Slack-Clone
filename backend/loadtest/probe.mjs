// T.33 load-test probe: samples the backend processes (CPU %, RSS), Postgres
// connections to the load database, and Redis round-trip latency from the
// host every SAMPLE_MS, writing CSV to stdout until killed.
//   node loadtest/probe.mjs <pidA,pidB> <redis-url> <psql-binary> <pg-url-without-db> <db> [sampleMs]
import { execFileSync } from 'child_process';
import Redis from 'ioredis';

const [pidsArg, redisUrl, psql, pgUrl, db, sampleArg] = process.argv.slice(2);
const pids = pidsArg.split(',').filter(Boolean);
const sampleMs = Number(sampleArg) || 2000;
const redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 1 });

const header = ['ts', ...pids.flatMap((p) => [`cpu_${p}`, `rss_mb_${p}`]), 'pg_connections', 'redis_ping_ms', 'redis_clients', 'redis_ops_per_sec'];
console.log(header.join(','));

const sample = async () => {
  const row = [new Date().toISOString()];
  for (const pid of pids) {
    try {
      const [cpu, rss] = execFileSync('ps', ['-o', '%cpu=,rss=', '-p', pid]).toString().trim().split(/\s+/);
      row.push(cpu, (Number(rss) / 1024).toFixed(1));
    } catch {
      row.push('', '');
    }
  }
  try {
    row.push(execFileSync(psql, [`${pgUrl}/postgres`, '-tAc', `SELECT count(*) FROM pg_stat_activity WHERE datname='${db}'`]).toString().trim());
  } catch {
    row.push('');
  }
  try {
    const t0 = process.hrtime.bigint();
    await redis.ping();
    row.push((Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2));
    const info = await redis.info();
    row.push(/connected_clients:(\d+)/.exec(info)?.[1] ?? '', /instantaneous_ops_per_sec:(\d+)/.exec(info)?.[1] ?? '');
  } catch {
    row.push('', '', '');
  }
  console.log(row.join(','));
};

setInterval(() => void sample(), sampleMs);
process.on('SIGTERM', () => {
  redis.disconnect();
  process.exit(0);
});
