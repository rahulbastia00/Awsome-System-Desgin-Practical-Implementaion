-- CreateTable
CREATE TABLE "urls" (
    "id" TEXT NOT NULL,
    "short_code" VARCHAR(50) NOT NULL,
    "long_url" TEXT NOT NULL,
    "user_id" VARCHAR(100),
    "clicks" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "last_accessed" TIMESTAMP(3),

    CONSTRAINT "urls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "urls_short_code_key" ON "urls"("short_code");

-- CreateIndex
CREATE INDEX "urls_created_at_idx" ON "urls"("created_at");
