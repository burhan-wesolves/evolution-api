-- CreateTable
CREATE TABLE `MessageDelivery` (
    `id` VARCHAR(191) NOT NULL,
    `instanceId` VARCHAR(191) NOT NULL,
    `keyId` VARCHAR(100) NOT NULL,
    `remoteJid` VARCHAR(100) NOT NULL,
    `messageTimestamp` INTEGER NOT NULL,
    `payload` JSON NULL,
    `status` ENUM('pending', 'delivered', 'failed') NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lastError` VARCHAR(500) NULL,
    `deliveredAt` TIMESTAMP NULL,
    `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` TIMESTAMP NOT NULL,

    INDEX `MessageDelivery_instanceId_status_messageTimestamp_idx`(`instanceId`, `status`, `messageTimestamp`),
    UNIQUE INDEX `MessageDelivery_instanceId_keyId_key`(`instanceId`, `keyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WatchmanInstance` (
    `instanceId` VARCHAR(191) NOT NULL,
    `watchingSince` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` TIMESTAMP NOT NULL,

    PRIMARY KEY (`instanceId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `MessageDelivery` ADD CONSTRAINT `MessageDelivery_instanceId_fkey` FOREIGN KEY (`instanceId`) REFERENCES `Instance`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WatchmanInstance` ADD CONSTRAINT `WatchmanInstance_instanceId_fkey` FOREIGN KEY (`instanceId`) REFERENCES `Instance`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

