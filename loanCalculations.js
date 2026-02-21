'use strict';

/**
 * loanCalculations.js
 * Pure financial calculation utilities for Digital Girvi.
 * All functions are stateless and dependency-free (no DB, no I/O).
 *
 * Interest model: Simple interest (flat monthly rate on outstanding principal).
 * Formula: Interest = Principal × Rate% × Months
 */

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------
const PURITY_FACTORS = {
  '24K': 1.0000,
  '22K': 0.9167,
  '20K': 0.8333,
  '18K': 0.7500,
  '16K': 0.6667,
  '14K': 0.5833,
};

// ----------------------------------------------------------------
// Rounding helper — always round to 2 decimal places
// ----------------------------------------------------------------
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// ----------------------------------------------------------------
// 1. GOLD VALUATION
// ----------------------------------------------------------------
const calculateGoldValue = (netWeightGrams, purity, goldRatePerGram) => {
  const purityFactor   = PURITY_FACTORS[purity] ?? PURITY_FACTORS['22K'];
  const pureGoldWeight = round2(netWeightGrams * purityFactor);
  const marketValue    = round2(pureGoldWeight * goldRatePerGram);
  return { pureGoldWeight, marketValue, purityFactor };
};

const calculateTotalGoldValue = (items) => {
  let totalNetWeight = 0, totalPureWeight = 0, totalMarketValue = 0;
  for (const item of items) {
    const { pureGoldWeight, marketValue } = calculateGoldValue(
      item.netWeightGrams, item.purity, item.goldRatePerGram
    );
    totalNetWeight   += item.netWeightGrams;
    totalPureWeight  += pureGoldWeight;
    totalMarketValue += marketValue;
  }
  return {
    totalNetWeight:   round2(totalNetWeight),
    totalPureWeight:  round2(totalPureWeight),
    totalMarketValue: round2(totalMarketValue),
  };
};

// ----------------------------------------------------------------
// 2. LOAN ELIGIBILITY
// ----------------------------------------------------------------
const calculateMaxLoanAmount = (appraisedValue, ltvPercent) =>
  Math.floor((appraisedValue * ltvPercent) / 100);

const calculateLTV = (principalAmount, appraisedValue) => {
  if (!appraisedValue || appraisedValue === 0) return 0;
  return round2((principalAmount / appraisedValue) * 100);
};

// ----------------------------------------------------------------
// 3. INTEREST CALCULATIONS
// ----------------------------------------------------------------
const calculateSimpleInterest = (principal, ratePerMonth, months) =>
  round2((principal * ratePerMonth * months) / 100);

const calculateDailyInterest = (principal, ratePerMonth, days) =>
  round2((principal * (ratePerMonth / 30) * days) / 100);

const calculateLoanPeriod = (startDate, endDate) => {
  const start     = new Date(startDate);
  const end       = new Date(endDate);
  const totalDays = Math.max(0, Math.ceil((end - start) / (1000 * 60 * 60 * 24)));
  return { months: Math.floor(totalDays / 30), days: totalDays % 30, totalDays };
};

const calculateAccruedInterest = (principal, ratePerMonth, startDate, asOfDate = new Date()) => {
  const { months, days, totalDays } = calculateLoanPeriod(startDate, asOfDate);
  const interest = round2(
    calculateSimpleInterest(principal, ratePerMonth, months) +
    calculateDailyInterest(principal, ratePerMonth, days)
  );
  return { months, days, totalDays, interest };
};

// ----------------------------------------------------------------
// 4. OVERDUE / PENALTY
// ----------------------------------------------------------------
const calculatePenalty = (principalOutstanding, penaltyRatePerMonth, dueDate, asOfDate = new Date()) => {
  const due  = new Date(dueDate);
  const asOf = new Date(asOfDate);
  if (asOf <= due) return { overdueDays: 0, overdueMonths: 0, penalty: 0, isOverdue: false };
  const { months, days, totalDays } = calculateLoanPeriod(due, asOf);
  const penalty = round2(
    calculateSimpleInterest(principalOutstanding, penaltyRatePerMonth, months) +
    calculateDailyInterest(principalOutstanding, penaltyRatePerMonth, days)
  );
  return { overdueDays: totalDays, overdueMonths: months, penalty, isOverdue: true };
};

// ----------------------------------------------------------------
// 5. OUTSTANDING BALANCE
// ----------------------------------------------------------------
const calculateOutstandingBalance = (loan, asOfDate = new Date()) => {
  const {
    principalAmount, principalPaid = 0,
    interestRate, penaltyRate = 1,
    startDate, dueDate,
    interestPaid = 0, penaltyPaid = 0,
  } = loan;

  const principalOutstanding = round2(principalAmount - principalPaid);
  const { interest: totalInterestAccrued } = calculateAccruedInterest(principalAmount, interestRate, startDate, asOfDate);
  const { penalty: totalPenaltyAccrued, isOverdue, overdueDays } = calculatePenalty(principalOutstanding, penaltyRate, dueDate, asOfDate);
  const interestOutstanding = round2(Math.max(0, totalInterestAccrued - interestPaid));
  const penaltyOutstanding  = round2(Math.max(0, totalPenaltyAccrued  - penaltyPaid));
  const totalOutstanding    = round2(principalOutstanding + interestOutstanding + penaltyOutstanding);

  return {
    principalAmount, principalPaid: round2(principalPaid), principalOutstanding,
    totalInterestAccrued, interestPaid: round2(interestPaid), interestOutstanding,
    totalPenaltyAccrued, penaltyPaid: round2(penaltyPaid), penaltyOutstanding,
    totalOutstanding, isOverdue, overdueDays,
  };
};

// ----------------------------------------------------------------
// 6. PAYMENT ALLOCATION (waterfall: penalty → interest → principal)
// ----------------------------------------------------------------
const allocatePayment = (paymentAmount, outstanding) => {
  const { penaltyOutstanding = 0, interestOutstanding = 0, principalOutstanding = 0 } = outstanding;
  let remaining = paymentAmount;
  const penaltyComponent   = round2(Math.min(remaining, penaltyOutstanding));   remaining = round2(remaining - penaltyComponent);
  const interestComponent  = round2(Math.min(remaining, interestOutstanding));  remaining = round2(remaining - interestComponent);
  const principalComponent = round2(Math.min(remaining, principalOutstanding)); remaining = round2(remaining - principalComponent);
  return { penaltyComponent, interestComponent, principalComponent, surplus: round2(Math.max(0, remaining)) };
};

// ----------------------------------------------------------------
// 7. SETTLEMENT
// ----------------------------------------------------------------
const calculateSettlementAmount = (loan, asOfDate = new Date()) => {
  const balance = calculateOutstandingBalance(loan, asOfDate);
  return { ...balance, settlementAmount: balance.totalOutstanding, settlementDate: new Date(asOfDate).toISOString().split('T')[0] };
};

// ----------------------------------------------------------------
// 8. EMI (reducing balance)
// ----------------------------------------------------------------
const calculateEMI = (principal, annualRatePercent, tenureMonths) => {
  const r = annualRatePercent / 12 / 100;
  if (r === 0) {
    const emi = round2(principal / tenureMonths);
    return { emi, totalPayable: round2(emi * tenureMonths), totalInterest: 0 };
  }
  const factor = Math.pow(1 + r, tenureMonths);
  const emi    = round2((principal * r * factor) / (factor - 1));
  const totalPayable  = round2(emi * tenureMonths);
  return { emi, totalPayable, totalInterest: round2(totalPayable - principal) };
};

// ----------------------------------------------------------------
// 9. INTEREST SCHEDULE
// ----------------------------------------------------------------
const generateInterestSchedule = (principal, ratePerMonth, startDate, durationMonths) => {
  const schedule = [];
  const start    = new Date(startDate);
  for (let i = 0; i < durationMonths; i++) {
    const periodStart = new Date(start);
    periodStart.setMonth(periodStart.getMonth() + i);
    const periodEnd = new Date(periodStart);
    periodEnd.setMonth(periodEnd.getMonth() + 1);
    periodEnd.setDate(periodEnd.getDate() - 1);
    schedule.push({
      period:      i + 1,
      periodStart: periodStart.toISOString().split('T')[0],
      periodEnd:   periodEnd.toISOString().split('T')[0],
      interest:    calculateSimpleInterest(principal, ratePerMonth, 1),
    });
  }
  return schedule;
};

// ----------------------------------------------------------------
// 10. DATE HELPERS
// ----------------------------------------------------------------
const calculateDueDate = (startDate, durationMonths) => {
  const date = new Date(startDate);
  date.setMonth(date.getMonth() + durationMonths);
  return date.toISOString().split('T')[0];
};

const isDueSoon   = (dueDate, withinDays = 7) => {
  const diff = (new Date(dueDate) - new Date()) / (1000 * 60 * 60 * 24);
  return diff >= 0 && diff <= withinDays;
};
const isOverdue   = (dueDate) => new Date() > new Date(dueDate);
const getDaysOverdue = (dueDate) => Math.floor((new Date() - new Date(dueDate)) / (1000 * 60 * 60 * 24));

// ----------------------------------------------------------------
// 11. FEES & WEIGHT
// ----------------------------------------------------------------
const calculateProcessingFee = (principal, feePercent = 0, flatFee = 0, minFee = 0, maxFee = 0) => {
  let fee = flatFee > 0 ? flatFee : round2((principal * feePercent) / 100);
  if (minFee > 0) fee = Math.max(fee, minFee);
  if (maxFee > 0) fee = Math.min(fee, maxFee);
  return round2(fee);
};

const getPurityFactor  = (purity) => PURITY_FACTORS[purity] ?? 0;
const calculateNetWeight = (grossWeight, stoneWeight = 0) => round2(Math.max(0, grossWeight - stoneWeight));

module.exports = {
  calculateGoldValue, calculateTotalGoldValue, calculateNetWeight, getPurityFactor, PURITY_FACTORS,
  calculateMaxLoanAmount, calculateLTV,
  calculateSimpleInterest, calculateDailyInterest, calculateLoanPeriod, calculateAccruedInterest,
  calculatePenalty,
  calculateOutstandingBalance, calculateSettlementAmount, allocatePayment,
  calculateEMI, generateInterestSchedule,
  calculateDueDate, isDueSoon, isOverdue, getDaysOverdue,
  calculateProcessingFee, round2,
};
