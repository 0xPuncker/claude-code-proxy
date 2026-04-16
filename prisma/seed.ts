import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Starting database seed...')

  // Seed example daily usage data
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  // Example daily usage for today
  await prisma.dailyUsage.upsert({
    where: {
      date_model_provider: {
        date: today,
        model: 'claude-sonnet-4-20250514',
        provider: 'zai'
      }
    },
    update: {},
    create: {
      date: today,
      model: 'claude-sonnet-4-20250514',
      provider: 'zai',
      totalRequests: 150,
      totalInputTokens: 125000,
      totalOutputTokens: 89000,
      totalCacheReadTokens: 5000,
      totalCacheCreationTokens: 2000,
      totalTokens: 221000,
      totalDurationMs: 45600000
    }
  })

  // Example daily usage for yesterday
  await prisma.dailyUsage.upsert({
    where: {
      date_model_provider: {
        date: yesterday,
        model: 'claude-sonnet-4-20250514',
        provider: 'anthropic'
      }
    },
    update: {},
    create: {
      date: yesterday,
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      totalRequests: 89,
      totalInputTokens: 72000,
      totalOutputTokens: 56000,
      totalCacheReadTokens: 3000,
      totalCacheCreationTokens: 1500,
      totalTokens: 132500,
      totalDurationMs: 28900000
    }
  })

  console.log('✅ Seed completed successfully!')
  console.log('📊 Example data created:')
  console.log('  - 2 daily usage records')
  console.log('  - Total requests: 239')
  console.log('  - Total tokens: 353,500')
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
