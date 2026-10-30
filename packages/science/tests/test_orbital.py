import math
import unittest

import numpy as np

from siphon_science.numeric_inputs import NumericInputError
from siphon_science.orbital import central_invariants_si, isolated_invariants_si


def array(value):
    return np.asarray(value, dtype=np.float64)


class OrbitalTests(unittest.TestCase):
    # Unit-scale analytic fixtures: tolerance covers floating arithmetic only,
    # not a production scientific accuracy target.
    def central(self, r, v):
        return central_invariants_si(array(r), array(v), central_mu_m3_s2=1.0, maximum_samples=100)

    def isolated(self, r, v, m):
        return isolated_invariants_si(
            array(r),
            array(v),
            array(m),
            gravitational_constant=1.0,
            maximum_samples=100,
            maximum_bodies=32,
        )

    def test_unit_circular_central_orbit(self):
        phase = np.linspace(0, 2 * math.pi, 33)
        r = np.stack((np.cos(phase), np.sin(phase)), axis=1)
        v = np.stack((-np.sin(phase), np.cos(phase)), axis=1)
        result = self.central(r, v)
        np.testing.assert_allclose(result.specific_energy_m2_s2, -0.5, rtol=0, atol=1e-15)
        np.testing.assert_allclose(
            result.specific_angular_momentum_m2_s, np.tile([0, 0, 1], (33, 1)), rtol=0, atol=1e-15
        )
        self.assertFalse(result.specific_energy_m2_s2.flags.writeable)
        self.assertFalse(hasattr(result, "momentum_kg_m_s"))

    def test_eccentric_apsides_from_vis_viva(self):
        # a=2,e=1/2 => rp=1,ra=3,E=-1/4,h=sqrt(3/2).
        result = self.central([[1, 0], [-3, 0]], [[0, math.sqrt(1.5)], [0, -math.sqrt(1 / 6)]])
        np.testing.assert_allclose(result.specific_energy_m2_s2, -0.25, rtol=0, atol=3e-16)
        np.testing.assert_allclose(
            result.specific_angular_momentum_m2_s[:, 2], math.sqrt(1.5), rtol=0, atol=3e-16
        )

    def test_equal_mass_binary_analytic_invariants(self):
        # G=m=1, separation2, radius1: centripetal v^2=1/4.
        result = self.isolated([[[-1, 0], [1, 0]]], [[[0, -0.5], [0, 0.5]]], [1, 1])
        np.testing.assert_array_equal(result.energy_j, [-0.25])
        np.testing.assert_array_equal(result.angular_momentum_kg_m2_s, [[0, 0, 1]])
        np.testing.assert_array_equal(result.momentum_kg_m_s, [[0, 0, 0]])
        np.testing.assert_array_equal(result.center_of_mass_m, [[0, 0, 0]])

    def test_three_body_hand_sum_and_permutation(self):
        # Pair distances3,4,5; U=-(2/3+3/4+6/5), K=6.
        # Lz = 2*3*2 + 3*(-4)*(-1) = 24.
        r = array([[[0, 0, 0], [3, 0, 0], [0, 4, 0]]])
        v = array([[[1, 0, 0], [0, 2, 0], [-1, 0, 0]]])
        m = array([1, 2, 3])
        for order in ([0, 1, 2], [2, 0, 1]):
            result = self.isolated(r[:, order], v[:, order], m[order])
            np.testing.assert_allclose(result.energy_j, [203 / 60], rtol=0, atol=1e-15)
            np.testing.assert_array_equal(result.angular_momentum_kg_m2_s, [[0, 0, 24]])
            np.testing.assert_array_equal(result.momentum_kg_m_s, [[-2, 4, 0]])
            np.testing.assert_array_equal(result.center_of_mass_m, [[1, 2, 0]])

    def test_spatial_rotation_and_translation_identities(self):
        r = array([[[0, 0, 0], [3, 0, 0], [0, 4, 0]]])
        v = array([[[1, 0, 0], [0, 2, 0], [-1, 0, 0]]])
        baseline = self.isolated(r, v, [1, 2, 3])
        shift = array([1, -2, 3])
        translated = self.isolated(r + shift, v, [1, 2, 3])
        np.testing.assert_allclose(translated.energy_j, baseline.energy_j, rtol=0, atol=1e-15)
        np.testing.assert_array_equal(
            translated.angular_momentum_kg_m2_s,
            baseline.angular_momentum_kg_m2_s + np.cross(shift, baseline.momentum_kg_m_s),
        )
        # Proper cyclic rotation x->y,y->z,z->x, determinant+1.
        order = [2, 0, 1]
        rotated = self.isolated(r[:, :, order], v[:, :, order], [1, 2, 3])
        np.testing.assert_array_equal(
            rotated.angular_momentum_kg_m2_s, baseline.angular_momentum_kg_m2_s[:, order]
        )

    def test_speed_defect_changes_energy(self):
        normal = self.central([[1, 0]], [[0, 1]])
        faulty = self.central([[1, 0]], [[0, 1.1]])
        self.assertAlmostEqual(
            float(faulty.specific_energy_m2_s2[0] - normal.specific_energy_m2_s2[0]), 0.105
        )

    def test_collision_nonfinite_and_overflow_are_not_zero_error(self):
        for r, v in [([[0, 0]], [[0, 1]]), ([[1, 0]], [[np.nan, 1]]), ([[1, 0]], [[1e308, 1]])]:
            with self.assertRaises(NumericInputError):
                self.central(r, v)
        with self.assertRaisesRegex(NumericInputError, "point_mass_collision"):
            self.isolated([[[0, 0], [0, 0]]], [[[0, 1], [0, -1]]], [1, 1])

    def test_invalid_masses_shapes_and_caps_rejected(self):
        for masses in ([0, 1], [-1, 1], [np.inf, 1], [1]):
            with self.assertRaises(NumericInputError):
                self.isolated([[[0, 0], [1, 0]]], [[[0, 1], [0, -1]]], masses)
        with self.assertRaises(NumericInputError):
            self.central([[1]], [[1]])
        with self.assertRaisesRegex(NumericInputError, "orbital_dimension_limit"):
            central_invariants_si(
                array([[1, 0], [0, 1]]),
                array([[0, 1], [-1, 0]]),
                central_mu_m3_s2=1,
                maximum_samples=1,
            )


if __name__ == "__main__":
    unittest.main()
