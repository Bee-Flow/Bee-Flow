#!/usr/bin/env bash
# ROCm 7.x compatibility patch for ROCm/CTranslate2 (amd_dev branch).
#
# The fork's cuda2hip_macros.hpp targets the hipBLAS v1 API, which ROCm 7
# removed: the `hipblasDatatype_t` typedef is gone, and `hipblasGemmEx` /
# `hipblasGemmStridedBatchedEx` now take `hipblasComputeType_t` for their
# compute-type parameter instead of a data-type enum. The CUDA code CT2 is
# written against passes `cudaDataType_t` there (cuBLAS's legacy overload,
# which CUDA still accepts) — so a plain name-for-name macro cannot bridge
# the two APIs any more.
#
# This script, run against a fresh clone at $1:
#   1. installs a shim header with wrappers that convert the compute-type
#      argument (hipDataType → hipblasComputeType_t) before calling the v2
#      functions;
#   2. repoints the macros at the shim and at `hipDataType`;
#   3. adds thrust includes that ROCm 7's slimmed-down rocThrust no longer
#      pulls in transitively (counting/transform iterator, reduce).
#
# Verified against: ROCm 7.2.1, gfx1151, amd_dev @ 2026-07.
set -euo pipefail

CT2_SRC="${1:?usage: ct2-rocm7-compat.sh <ctranslate2-source-dir>}"

cat > "$CT2_SRC/src/ct2_hipblas_compat.hpp" <<'EOF'
#pragma once
// hipBLAS v2 compatibility wrappers — see ct2-rocm7-compat.sh for why.
#ifdef __HIP_PLATFORM_AMD__
#include <hipblas/hipblas.h>

static inline hipblasComputeType_t ct2_hip_compute_type(hipDataType t) {
  switch (static_cast<int>(t)) {
    case HIP_R_16F: return HIPBLAS_COMPUTE_16F;
    case HIP_R_32I: return HIPBLAS_COMPUTE_32I;
    default:        return HIPBLAS_COMPUTE_32F;
  }
}

static inline hipblasStatus_t ct2_hipblasGemmEx(
    hipblasHandle_t handle, hipblasOperation_t ta, hipblasOperation_t tb,
    int m, int n, int k, const void* alpha,
    const void* A, hipDataType Atype, int lda,
    const void* B, hipDataType Btype, int ldb, const void* beta,
    void* C, hipDataType Ctype, int ldc,
    hipDataType computeType, hipblasGemmAlgo_t algo) {
  return hipblasGemmEx(handle, ta, tb, m, n, k, alpha, A, Atype, lda,
                       B, Btype, ldb, beta, C, Ctype, ldc,
                       ct2_hip_compute_type(computeType), algo);
}

static inline hipblasStatus_t ct2_hipblasGemmStridedBatchedEx(
    hipblasHandle_t handle, hipblasOperation_t ta, hipblasOperation_t tb,
    int m, int n, int k, const void* alpha,
    const void* A, hipDataType Atype, int lda, hipblasStride strideA,
    const void* B, hipDataType Btype, int ldb, hipblasStride strideB,
    const void* beta, void* C, hipDataType Ctype, int ldc, hipblasStride strideC,
    int batchCount, hipDataType computeType, hipblasGemmAlgo_t algo) {
  return hipblasGemmStridedBatchedEx(handle, ta, tb, m, n, k, alpha,
                                     A, Atype, lda, strideA,
                                     B, Btype, ldb, strideB, beta,
                                     C, Ctype, ldc, strideC, batchCount,
                                     ct2_hip_compute_type(computeType), algo);
}
#endif
EOF

MACROS="$CT2_SRC/src/cuda2hip_macros.hpp"

# Shim must be visible before any macroified call site.
sed -i 's|#include <hip/hip_runtime.h>|#include <hip/hip_runtime.h>\n    #include "ct2_hipblas_compat.hpp"|' "$MACROS"

# v1 typedef is gone; the enum values (HIPBLAS_R_*) survive as hipDataType aliases.
sed -i 's|#define cudaDataType_t hipblasDatatype_t|#define cudaDataType_t hipDataType|' "$MACROS"

# Route the two signature-incompatible calls through the wrappers.
sed -i 's|#define cublasGemmEx hipblasGemmEx|#define cublasGemmEx ct2_hipblasGemmEx|' "$MACROS"
sed -i 's|#define cublasGemmStridedBatchedEx hipblasGemmStridedBatchedEx|#define cublasGemmStridedBatchedEx ct2_hipblasGemmStridedBatchedEx|' "$MACROS"

# rocThrust 7.x pruned its transitive includes: every thrust algorithm the
# CT2 sources touch must now be included explicitly. Unused ones are free.
sed -i 's|#pragma once|#pragma once\n#include <thrust/iterator/counting_iterator.h>\n#include <thrust/iterator/transform_iterator.h>\n#include <thrust/reduce.h>\n#include <thrust/extrema.h>\n#include <thrust/functional.h>\n#include <thrust/transform.h>\n#include <thrust/for_each.h>\n#include <thrust/copy.h>\n#include <thrust/fill.h>\n#include <thrust/sequence.h>\n#include <thrust/sort.h>\n#include <thrust/execution_policy.h>|' \
    "$CT2_SRC/src/cuda/helpers.h"

echo "ct2-rocm7-compat: patched $MACROS"
