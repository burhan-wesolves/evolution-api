-- Key the watchman ledger by instance NAME instead of instance id.
--
-- Deleting and recreating an instance is how you reconnect after a logout, and
-- it mints a new Instance row. The previous cascade from Instance therefore
-- wiped the whole ledger at the exact moment it mattered, losing every message
-- still pending -- observed live: an instance recreate removed every row. The
-- name is stable across a recreate, so tags survive it, which also means
-- messages already marked delivered stay marked and the history sync that
-- follows a re-pair is skipped by the tag rather than re-examined.
--
-- Written so it cannot fail on a table that already has rows: the new column
-- arrives with a default, which is then dropped.

-- DropForeignKey
ALTER TABLE `MessageDelivery` DROP FOREIGN KEY `MessageDelivery_instanceId_fkey`;
ALTER TABLE `WatchmanInstance` DROP FOREIGN KEY `WatchmanInstance_instanceId_fkey`;

-- DropIndex
DROP INDEX `MessageDelivery_instanceId_status_messageTimestamp_idx` ON `MessageDelivery`;
DROP INDEX `MessageDelivery_instanceId_keyId_key` ON `MessageDelivery`;

-- AlterTable: instanceId stays as a plain, optional column for debugging;
-- instanceName becomes the identity.
ALTER TABLE `MessageDelivery` ADD COLUMN `instanceName` VARCHAR(255) NOT NULL DEFAULT '',
    MODIFY `instanceId` VARCHAR(255) NULL;
ALTER TABLE `MessageDelivery` ALTER COLUMN `instanceName` DROP DEFAULT;

-- WatchmanInstance holds only a replay floor, which is re-created on the next
-- startup, so it is rebuilt rather than migrated in place.
DROP TABLE IF EXISTS `WatchmanInstance`;
CREATE TABLE `WatchmanInstance` (
    `instanceName` VARCHAR(255) NOT NULL,
    `watchingSince` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` TIMESTAMP NOT NULL,

    PRIMARY KEY (`instanceName`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `MessageDelivery_instanceName_status_messageTimestamp_idx` ON `MessageDelivery`(`instanceName`, `status`, `messageTimestamp`);
CREATE UNIQUE INDEX `MessageDelivery_instanceName_keyId_key` ON `MessageDelivery`(`instanceName`, `keyId`);
