import bcrypt from 'bcryptjs';
import { prisma } from './lib/prisma.js';

// Stage 1B (T.30): development-only. Nothing here has a default password and
// no password is ever printed. Supply both before running, e.g.
//   SEED_USER_PASSWORD='<12+ chars>' SEED_ADMIN_PASSWORD='<12+ chars>' npx tsx seed.ts
const SEED_PASSWORD_MIN = 12;
const refuse = (reason: string) => {
  console.error(`Refusing to seed: ${reason}`);
  process.exit(1);
};
if (process.env.NODE_ENV === 'production') refuse('this development seed must never run with NODE_ENV=production.');
const seedPassword = (name: string) => {
  const value = process.env[name] ?? '';
  if (value.length < SEED_PASSWORD_MIN) refuse(`set ${name} (at least ${SEED_PASSWORD_MIN} characters; it is never printed).`);
  return value;
};
const SEED_USER_PASSWORD = seedPassword('SEED_USER_PASSWORD');
const SEED_ADMIN_PASSWORD = seedPassword('SEED_ADMIN_PASSWORD');

async function seed() {
  try {
    console.log('🌱 Seeding database...');

    // Create test user
    const hashedPassword = await bcrypt.hash(SEED_USER_PASSWORD, 12);
    const user = await prisma.user.create({
      data: {
        username: 'testuser',
        email: 'test@example.com',
        password: hashedPassword
      }
    });

    console.log('✅ Test user created:');
    console.log('   Email: test@example.com');
    console.log('   Password: (SEED_USER_PASSWORD, not printed)');

    // Create admin user
    const adminHashedPassword = await bcrypt.hash(SEED_ADMIN_PASSWORD, 12);
    const admin = await prisma.user.create({
      data: {
        username: 'admin',
        email: 'admin@slack.com',
        password: adminHashedPassword
      }
    });

    console.log('✅ Admin user created:');
    console.log('   Email: admin@slack.com');
    console.log('   Password: (SEED_ADMIN_PASSWORD, not printed)');

    // Create general channel
    const generalChannel = await prisma.channel.create({
      data: {
        name: 'general',
        description: 'General discussion channel',
        createdBy: user.id
      }
    });

    console.log('✅ General channel created');

    // Add users to general channel
    await prisma.channelMember.createMany({
      data: [
        { userId: user.id, channelId: generalChannel.id, role: 'member' },
        { userId: admin.id, channelId: generalChannel.id, role: 'admin' }
      ]
    });

    console.log('✅ Users added to general channel');
    console.log('\n🎉 Database seeding complete!');

    process.exit(0);
  } catch (error) {
    console.error('❌ Seeding error:', error);
    process.exit(1);
  }
}

seed();
