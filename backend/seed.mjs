import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function seed() {
  try {
    console.log('🌱 Seeding database...');

    // Create test user
    const hashedPassword = await bcrypt.hash('password123', 12);
    const user = await prisma.user.create({
      data: {
        username: 'testuser',
        email: 'test@example.com',
        password: hashedPassword
      }
    });

    console.log('✅ Test user created:');
    console.log('   Email: test@example.com');
    console.log('   Password: password123');

    // Create admin user
    const adminHashedPassword = await bcrypt.hash('admin123', 12);
    const admin = await prisma.user.create({
      data: {
        username: 'admin',
        email: 'admin@slack.com',
        password: adminHashedPassword
      }
    });

    console.log('✅ Admin user created:');
    console.log('   Email: admin@slack.com');
    console.log('   Password: admin123');

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

    await prisma.$disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Seeding error:', error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

seed();
