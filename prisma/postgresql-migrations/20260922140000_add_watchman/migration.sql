-- CreateEnum
CREATE TYPE "MessageDeliveryStatus" AS ENUM ('pending', 'delivered', 'failed');

-- CreateTable
CREATE TABLE "MessageDelivery" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "keyId" VARCHAR(100) NOT NULL,
    "remoteJid" VARCHAR(100) NOT NULL,
    "messageTimestamp" INTEGER NOT NULL,
    "payload" JSONB,
    "status" "MessageDeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(500),
    "deliveredAt" TIMESTAMP,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL,

    CONSTRAINT "MessageDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchmanInstance" (
    "instanceId" TEXT NOT NULL,
    "watchingSince" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL,

    CONSTRAINT "WatchmanInstance_pkey" PRIMARY KEY ("instanceId")
);

-- CreateIndex
CREATE INDEX "MessageDelivery_instanceId_status_messageTimestamp_idx" ON "MessageDelivery"("instanceId", "status", "messageTimestamp");

-- CreateIndex
CREATE UNIQUE INDEX "MessageDelivery_instanceId_keyId_key" ON "MessageDelivery"("instanceId", "keyId");

-- AddForeignKey
ALTER TABLE "MessageDelivery" ADD CONSTRAINT "MessageDelivery_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchmanInstance" ADD CONSTRAINT "WatchmanInstance_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

